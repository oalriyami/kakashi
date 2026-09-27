# Kakashi Manager Presentation

Files:

- `build.js` — dependency-free generator for the `Kakashi_Manager_Briefing.fodp`
  deck, the editable open presentation source.
- `SPEAKER_NOTES.md` — concise notes and transitions for every slide.

The generated deck (`.fodp`, `.pptx` and a portable `.pdf` backup) is not
committed. Build it locally, or download it from the latest GitHub release,
where `.github/workflows/release-docs.yml` attaches it.

The deck follows the six independently runnable cases in `demos/` and avoids
claims that Kakashi guarantees or certifies legal compliance.

## Build

On a machine with Node.js and LibreOffice Impress:

```bash
npm run docs:deck
```

which runs:

```bash
node presentation/build.js
soffice --headless --convert-to pptx --outdir presentation \
  presentation/Kakashi_Manager_Briefing.fodp
soffice --headless --convert-to pdf --outdir presentation \
  presentation/Kakashi_Manager_Briefing.fodp
```

Open the PowerPoint once before the meeting to confirm that the installed fonts
have not caused line wrapping. The design uses a common sans-serif family with
safe substitutes across Linux, Windows, and macOS.
