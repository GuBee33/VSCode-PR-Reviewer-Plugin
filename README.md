# PR Reviewer – Copilot Edition 🎬

A VS Code extension that reviews your pull request diff using **GitHub Copilot**, narrated by an animated character with a configurable reviewer persona (default: **Ricky Gervais**).

---

## Features

| Feature | Description |
|---|---|
| 🤖 **Copilot-powered review** | Uses the VS Code Language Model API to send your branch diff to Copilot and get back structured findings |
| 🧍 **Animated sidebar character** | Your character lives in the Activity Bar — idle while waiting, walking while reviewing |
| 🔴🟡🔵 **Inline decorations** | Findings are highlighted directly in your editor with coloured gutters and hover tooltips |
| ⚙️ **Configurable persona** | Set the reviewer style to anything: Ricky Gervais, Gordon Ramsay, a disappointed professor… |
| 📋 **Findings panel** | All findings are listed in the sidebar; click any to jump to the relevant file and line |
| 📊 **Status bar indicator** | Bottom-left corner shows live review progress and a summary when done |

---

## Requirements

- VS Code **1.90** or later
- **GitHub Copilot** extension installed and authenticated

---

## Usage

1. Open a Git repository in VS Code
2. Click the **PR Reviewer** icon in the Activity Bar (left navigation)
3. Click the **▶ play button** in the sidebar toolbar to start a review  
   — or run **`PR Reviewer: Review Current PR / Branch Diff`** from the Command Palette (`Ctrl+Shift+P`)
4. The extension diffs your current branch against the configured base branch (`main` by default)
5. Watch your character walk while Copilot reviews the diff
6. Findings appear in the sidebar and are highlighted inline in your editor

---

## Sidebar Toolbar

| Button | Action |
|---|---|
| ▶ | Start a review |
| ⚙ | Open PR Reviewer settings |

---

## Configuration

Open settings via the **⚙ gear icon** in the sidebar toolbar, or go to **File → Preferences → Settings** and search `prReviewer`.

| Setting | Default | Description |
|---|---|---|
| `prReviewer.reviewerStyle` | `"Ricky Gervais"` | Reviewer persona used in the prompt |
| `prReviewer.extraInstructions` | `""` | Extra instructions appended to the prompt |
| `prReviewer.baseBranch` | `"main"` | Base branch to diff against |
| `prReviewer.model` | `"copilot-gpt-4o"` | Copilot model ID |

Example `settings.json`:

```json
"prReviewer.reviewerStyle": "Gordon Ramsay",
"prReviewer.baseBranch": "develop",
"prReviewer.extraInstructions": "Focus on security issues only."
```

---

## Installation (local build)

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Then reload VS Code: `Ctrl+Shift+P` → **Developer: Reload Window**.

### Manual development loop

```bash
npm install
npm run compile   # one-shot build
npm run watch     # watch mode
```

Press `F5` to launch an Extension Development Host without packaging.

---

## Commands

| Command | Description |
|---|---|
| `PR Reviewer: Review Current PR / Branch Diff` | Run the review |
| `PR Reviewer: Clear All Review Decorations` | Remove all inline highlights |
| `PR Reviewer: Settings` | Open settings filtered to prReviewer |

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

