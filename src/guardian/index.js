/**
 * Kakashi Guardian -- the agent loop.
 *
 *   GOAL -> OBSERVE -> ASSESS -> PLAN -> VALIDATE -> ACT -> OBSERVE RESULT
 *        -> VERIFY -> satisfied? -> RELEASE | UPDATE STATE + REPLAN | HUMAN | BLOCK
 *
 * Everything security-critical below is ordinary deterministic code, and every
 * transformation is performed by the Kakashi engine that already shipped in
 * v1.1. No LLM, no agent framework, no new runtime dependency -- what makes this
 * agentic is that the Guardian holds a goal and state, reads the environment
 * after it acts, and lets that reading change what it does next.
 *
 * Termination is guaranteed: every path out of the loop is terminal, the
 * iteration counter is checked against goal.maxIterations at the top, and the
 * planner reports when a class has no untried options left.
 *
 * Fail-closed guarantees:
 *   - Intermediate artifacts are written to a private scratch directory. The
 *     output path is only written on a verified-safe decision, so a BLOCK or a
 *     REQUIRE_APPROVAL leaves nothing releasable on disk -- including a
 *     `guarded_` file an earlier run left there, which is removed before this
 *     run starts (#48).
 *   - The scratch directory is removed when the run ends, and on SIGINT,
 *     SIGTERM or SIGHUP while it is running.
 *   - The original resource is never modified. There is no override flag.
 *   - Any unexpected error terminates the run as FAILED with no artifact.
 */

const fs = require('fs');
const { writeFileSafe } = require('../lib/safe-write');
const os = require('os');
const path = require('path');

const { SecurityGoal } = require('./goal');
const { GuardianContext } = require('./context');
const { GuardianState, STATUS } = require('./state');
const { observe } = require('./observe');
const { RiskEngine } = require('./risk');
const { Planner } = require('./planner');
const { PolicyGuard, rulesFor } = require('./policy');
const { Executor } = require('./executor');
const { Verifier } = require('./verifier');
const audit = require('./audit');
const paths = require('./paths');

/**
 * Approval name for releasing a file that holds content Kakashi could not read
 * (an OLE object, an ActiveX control, a macro project). Granted like a data
 * class: `--approve UNSCANNED_CONTENT`.
 */
const UNSCANNED_CONTENT = 'UNSCANNED_CONTENT';

// ---------------------------------------------------------------------------
// Scratch directories of the runs in progress, removed if the process is
// interrupted. `finally` does not run when a signal ends the process, which
// left partially-protected copies in the OS temp folder after a Ctrl-C (#48).
// The handlers are installed only while a run is in progress, and re-raise the
// signal when nothing else listens, so the process ends as it would have.
// ---------------------------------------------------------------------------
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const scratchDirs = new Set();
const signalHandlers = {};

function removeScratchDirs() {
  for (const dir of scratchDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  scratchDirs.clear();
}

function unhookSignals() {
  for (const sig of SIGNALS) {
    if (signalHandlers[sig]) process.removeListener(sig, signalHandlers[sig]);
    delete signalHandlers[sig];
  }
  process.removeListener('exit', removeScratchDirs);
}

function onSignal(sig) {
  removeScratchDirs();
  unhookSignals();
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}

/**
 * Let the event loop run. Scanning and masking are synchronous, and awaiting
 * an already-settled promise never reaches the loop, so without these a signal
 * handler could not run until the whole run was over. The loop yields at each
 * stage, so Ctrl-C takes effect at the next one.
 */
function yieldToSignals() {
  return new Promise((resolve) => setImmediate(resolve));
}

function trackScratch(dir) {
  scratchDirs.add(dir);
  if (scratchDirs.size === 1) {
    for (const sig of SIGNALS) {
      signalHandlers[sig] = () => onSignal(sig);
      process.on(sig, signalHandlers[sig]);
    }
    process.on('exit', removeScratchDirs);
  }
}

function releaseScratch(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  scratchDirs.delete(dir);
  if (scratchDirs.size === 0) unhookSignals();
}

/**
 * Remove a Guardian artifact an earlier run left at this run's output path.
 * Its data was judged against that run's task, destination and file; this run
 * may decide differently, and a stale `guarded_` copy beside a REQUIRE_APPROVAL
 * or a BLOCK reads as released (#48). Only a file carrying the Guardian's own
 * naming is removed -- see paths.isGuardianArtifactName.
 * @returns {boolean} whether a file was removed
 */
function removeStaleArtifact(artifactPath) {
  if (!paths.isGuardianArtifactName(artifactPath)) return false;
  let st;
  try {
    st = fs.lstatSync(artifactPath);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  if (!st.isFile()) return false; // resolveOutput has already refused links and devices
  fs.unlinkSync(artifactPath);
  return true;
}

const DECISIONS = {
  ALLOW: 'ALLOW',
  ALLOW_WITH_TRANSFORMATION: 'ALLOW_WITH_TRANSFORMATION',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
  BLOCK: 'BLOCK',
};

/**
 * Run the Guardian over one resource.
 *
 * @param {object} opts
 * @param {string} opts.resource - path to the resource the agent wants
 * @param {string} [opts.agent] - requesting agent id
 * @param {string} [opts.task] - what the agent says it is trying to do
 * @param {string} [opts.destination] - where the data could end up
 * @param {string} [opts.policy] - policy id
 * @param {string[]} [opts.approvals] - classes a human has already signed off
 * @param {string} [opts.output] - artifact path (default: guarded_<name>)
 * @param {object} [opts.goal] - SecurityGoal overrides (e.g. maxIterations)
 * @param {string|false} [opts.auditLog] - JSONL path, or false to skip writing
 * @param {function(object):void} [opts.onEvent] - progress callback for the CLI
 * @returns {Promise<object>} decision
 */
async function runGuardian(opts = {}) {
  const goal = new SecurityGoal(opts.goal || {});
  const context = new GuardianContext({
    resource: opts.resource,
    requestingAgent: opts.agent,
    task: opts.task,
    destination: opts.destination,
    policy: opts.policy,
    approvals: opts.approvals,
    networkAccess: opts.networkAccess,
  });
  const state = new GuardianState({ goal, context });
  const emit = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  // Validate both paths before doing anything else, so a traversal attempt or a
  // device-file target fails before we have read a single byte.
  const sourcePath = paths.resolveResource(opts.resource);
  const artifactPath = paths.resolveOutput(
    opts.output || paths.defaultArtifactPath(sourcePath),
    sourcePath,
  );

  const staleArtifactRemoved = removeStaleArtifact(artifactPath);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-guardian-'));
  trackScratch(scratch);

  /** Finish the run: set terminal status, build + write the audit event. */
  function finish({ decision, reasonCode, releasePath = null, extra = {} }) {
    const status = decision === DECISIONS.BLOCK ? STATUS.BLOCKED
      : decision === DECISIONS.REQUIRE_APPROVAL ? STATUS.WAITING_FOR_APPROVAL
        : STATUS.SAFE;
    state.record(status, reasonCode);
    const event = audit.buildEvent({ state, decision: { decision, reasonCode }, staleArtifactRemoved });
    const written = opts.auditLog === false ? { written: false, path: null } : audit.write(event, opts.auditLog);
    const result = {
      decision,
      reasonCode,
      releasePath,
      artifactPath: releasePath,
      risk: state.latestRisk ? state.latestRisk.toJSON() : null,
      observation: state.observations[0] ? state.observations[0].toJSON() : null,
      plan: state.authorizedPlans.length
        ? state.authorizedPlans[state.authorizedPlans.length - 1].toJSON()
        : (state.proposedPlans.length ? state.proposedPlans[state.proposedPlans.length - 1].toJSON() : null),
      verifications: state.verifications,
      iterations: state.iteration,
      approvalsNeeded: extra.approvalsNeeded || [],
      // A file at the output path this run did not write: an earlier artifact
      // under a name the Guardian does not own. It was left alone, and is not
      // a release.
      staleOutputKept: releasePath !== artifactPath && fs.existsSync(artifactPath),
      staleArtifactRemoved,
      auditEvent: event,
      auditLog: written,
      state,
    };
    emit({ kind: 'decision', decision, reasonCode });
    return result;
  }

  try {
    while (!state.isTerminal) {
      // --- Termination bound ------------------------------------------------
      if (state.iteration >= goal.maxIterations) {
        emit({ kind: 'exhausted', iterations: state.iteration });
        return finish({
          decision: DECISIONS.BLOCK,
          reasonCode: 'MAX_ITERATIONS_EXHAUSTED',
        });
      }
      const iteration = state.beginIteration();
      await yieldToSignals();

      // --- OBSERVE ----------------------------------------------------------
      // Re-read the source every iteration rather than caching it. The source is
      // the environment, and the environment can change under us between
      // iterations; a changed finding profile should be seen, not assumed away.
      state.record(STATUS.OBSERVING, 'observe_resource');
      const { minNameConfidence } = rulesFor(context.policy, context.destination.id);
      const { observation } = await observe(sourcePath, { kind: 'resource', minConfidence: minNameConfidence });
      state.addObservation(observation);
      await yieldToSignals();
      emit({ kind: 'observe', iteration, observation: observation.toJSON() });

      // --- UNDERSTAND TASK --------------------------------------------------
      // Analysed once when the context was built; recorded here so the run log
      // shows the stage, and emitted so a streaming caller sees it in order.
      state.record(STATUS.UNDERSTANDING_TASK, 'analyze_task');
      emit({ kind: 'task', iteration, analysis: context.taskAnalysis.toJSON() });

      // --- ASSESS -----------------------------------------------------------
      state.record(STATUS.ASSESSING, 'assess_risk');
      const assessment = RiskEngine.assess({ observation, context });
      state.addRiskAssessment(assessment);
      emit({ kind: 'assess', iteration, assessment: assessment.toJSON() });

      if (assessment.requiresImmediateBlock) {
        // A class the destination denies outright. No plan can fix this, so we
        // stop before writing anything at all.
        return finish({
          decision: DECISIONS.BLOCK,
          reasonCode: 'CLASS_DENIED_AT_DESTINATION',
        });
      }

      // Content Kakashi could not read cannot be vouched for. Before anything
      // is released outside the machine -- the original or a transformed copy,
      // which would carry the same embedded object -- a person has to accept
      // that the file was not fully checked.
      if (observation.unscannedParts > 0 && context.destination.external
        && !context.hasApprovalFor(UNSCANNED_CONTENT)) {
        const { destinationId, policyId } = rulesFor(context.policy, context.destination.id);
        state.addApprovalRequest({
          iteration,
          classes: [UNSCANNED_CONTENT],
          destination: destinationId,
          policy: policyId,
        });
        return finish({
          decision: DECISIONS.REQUIRE_APPROVAL,
          reasonCode: 'UNSCANNED_CONTENT',
          extra: { approvalsNeeded: [UNSCANNED_CONTENT] },
        });
      }

      // Nothing the policy objects to: release the original untouched. The
      // Guardian's job is to allow legitimate work, not to transform for its
      // own sake.
      const rules = rulesFor(context.policy, context.destination.id);
      const needsProtection = rules.prohibited.some((c) => observation.hasClass(c))
        || (goal.minimizeInformationDisclosure && rules.restricted.some((c) => observation.hasClass(c)));
      if (!needsProtection) {
        return finish({
          decision: DECISIONS.ALLOW,
          reasonCode: observation.totalFindings === 0 ? 'NO_SENSITIVE_DATA' : 'NO_PROTECTION_REQUIRED',
          releasePath: sourcePath,
        });
      }

      // --- PLAN -------------------------------------------------------------
      state.record(STATUS.PLANNING, 'create_plan');
      const plan = Planner.createPlan({ goal, observation, assessment, context, state });
      state.addProposedPlan(plan);
      emit({ kind: 'plan', iteration, plan: plan.toJSON() });

      if (plan.meta.exhaustedClasses.length > 0) {
        // Every permitted transform has already been tried for these classes and
        // the artifact is still unsafe. Fail closed rather than loop.
        return finish({
          decision: DECISIONS.BLOCK,
          reasonCode: 'PROTECTION_EXHAUSTED',
          extra: { exhaustedClasses: plan.meta.exhaustedClasses },
        });
      }

      // --- VALIDATE PLAN ----------------------------------------------------
      state.record(STATUS.VALIDATING_PLAN, 'policy_guard');
      const authorized = PolicyGuard.validate(plan, context, state);
      emit({ kind: 'validate', iteration, authorized: authorized.toJSON() });

      if (authorized.rejected) {
        // The policy refused this plan. Record which tools it refused for which
        // classes so the planner excludes them next time, then replan.
        state.recordRejection({ violations: authorized.violations });
        state.record(STATUS.REPLANNING, 'policy_rejected_plan');
        continue;
      }

      if (authorized.requiresHuman) {
        state.addApprovalRequest({
          iteration,
          classes: authorized.approvalsNeeded,
          destination: rules.destinationId,
          policy: rules.policyId,
        });
        return finish({
          decision: DECISIONS.REQUIRE_APPROVAL,
          reasonCode: 'HUMAN_APPROVAL_REQUIRED',
          extra: { approvalsNeeded: authorized.approvalsNeeded },
        });
      }

      state.addAuthorizedPlan(plan);

      // --- ACT --------------------------------------------------------------
      // Into scratch, never straight to the output path. Nothing becomes
      // releasable until the verifier has signed it off.
      state.record(STATUS.EXECUTING, 'execute_plan');
      const scratchArtifact = path.join(scratch, `iter${iteration}_${path.basename(artifactPath)}`);
      const result = await Executor.execute({
        authorized, sourcePath, artifactPath: scratchArtifact, minConfidence: minNameConfidence,
      });
      state.recordResult(result);
      await yieldToSignals();
      emit({ kind: 'execute', iteration, replacements: result.replacementCount, byClass: result.byClass });

      // --- VERIFY -----------------------------------------------------------
      state.record(STATUS.VERIFYING, 'verify_artifact');
      const verification = await Verifier.verify({ artifactPath: scratchArtifact, context, goal });
      state.recordVerification(verification);
      await yieldToSignals();
      emit({ kind: 'verify', iteration, verification });

      if (verification.goalSatisfied) {
        // Promote the scratch artifact to the real output path. A copy rather
        // than a rename, since scratch is in the OS temp dir and may be on
        // another filesystem -- and a copy that never follows a link planted
        // at the destination after paths.resolveOutput checked it (#33).
        writeFileSafe(artifactPath, fs.readFileSync(scratchArtifact));
        return finish({
          decision: DECISIONS.ALLOW_WITH_TRANSFORMATION,
          reasonCode: 'GOAL_SATISFIED',
          releasePath: artifactPath,
        });
      }

      // --- REPLAN -----------------------------------------------------------
      // The environment disagreed with the plan. The residue recorded in state
      // is what makes the next plan different from this one.
      state.record(STATUS.REPLANNING, 'verification_failed');
      emit({ kind: 'replan', iteration, residualClasses: verification.residualClasses });
    }

    // Unreachable in practice: every path above returns. Fail closed anyway.
    return finish({ decision: DECISIONS.BLOCK, reasonCode: 'LOOP_TERMINATED_WITHOUT_DECISION' });
  } catch (err) {
    state.record(STATUS.FAILED, 'internal_error');
    const event = audit.buildEvent({ state, decision: { decision: DECISIONS.BLOCK, reasonCode: 'INTERNAL_ERROR' }, staleArtifactRemoved });
    if (opts.auditLog !== false) audit.write(event, opts.auditLog);
    // Security-critical failure fails closed: no artifact, no release.
    const wrapped = new Error(`Guardian run failed: ${err.message}`);
    wrapped.cause = err;
    wrapped.state = state;
    throw wrapped;
  } finally {
    // Never leave partially-protected intermediates behind. A signal that came
    // in during the last stage is handled first: it ends the process, as it
    // would have without the handlers.
    await yieldToSignals();
    releaseScratch(scratch);
  }
}

module.exports = {
  runGuardian,
  DECISIONS,
  UNSCANNED_CONTENT,
  // Re-exported so callers (CLI, tests, future MCP/HTTP surfaces) have one entry
  // point rather than reaching into individual modules.
  SecurityGoal,
  GuardianContext,
  GuardianState,
  STATUS,
  RiskEngine,
  Planner,
  PolicyGuard,
  Executor,
  Verifier,
  audit,
  paths,
};
