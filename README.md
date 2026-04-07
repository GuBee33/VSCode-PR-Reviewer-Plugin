# PR Reviewer – Copilot Edition 🎬

A VS Code extension that reviews your pull request diff using **GitHub Copilot**, narrated by an animated cartoon character with a configurable reviewer persona (default: **Ricky Gervais**).

---

## Features

| Feature | Description |
|---|---|
| 🤖 **Copilot-powered review** | Uses the VS Code Language Model API to send your branch diff to Copilot and get back structured findings |
| 🎭 **Animated character** | A sprite-sheet-based cartoon character delivers the review findings with personality |
| 🔴🟡🔵 **Inline decorations** | Findings are highlighted directly in your editor files with coloured gutters and hover tooltips |
| ⚙️ **Configurable persona** | Set the reviewer style to anything (Ricky Gervais, Gordon Ramsay, a disappointed professor…) |
| 📋 **Findings panel** | A dedicated WebView panel lists all findings; click any to navigate to the relevant file and line |

---

## Requirements

- VS Code **1.90** or later
- **GitHub Copilot** extension installed and authenticated (the extension uses the `vscode.lm` API)

---

## Usage

1. Open a Git repository in VS Code
2. Run the command **`PR Reviewer: Review Current PR / Branch Diff`** from the Command Palette (`Ctrl+Shift+P`)
3. The extension diffs your current branch against the configured base branch (`main` by default)
4. Copilot reviews the diff in the style of the configured persona
5. Findings are shown in the panel and highlighted in your editor

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `prReviewer.reviewerStyle` | `"Ricky Gervais"` | Persona used in the review prompt |
| `prReviewer.extraInstructions` | `""` | Extra instructions appended to the prompt |
| `prReviewer.baseBranch` | `"main"` | Base branch to diff against |
| `prReviewer.model` | `"copilot-gpt-4o"` | Copilot model ID |
| `prReviewer.spritesheetPath` | `""` | Absolute path to a custom PNG sprite sheet |
| `prReviewer.spriteFrameWidth` | `64` | Width of a single sprite frame (px) |
| `prReviewer.spriteFrameHeight` | `64` | Height of a single sprite frame (px) |
| `prReviewer.spriteFrameCount` | `8` | Number of frames in the sprite sheet (horizontal layout) |

---

## Custom Sprite Sheet

To use your own animated character:

1. Create a PNG sprite sheet with all frames laid out **horizontally** (left → right)
2. Set `prReviewer.spritesheetPath` to the absolute path of your PNG
3. Update `spriteFrameWidth`, `spriteFrameHeight`, and `spriteFrameCount` to match

---

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host.

---

## Commands

| Command | Description |
|---|---|
| `PR Reviewer: Review Current PR / Branch Diff` | Run the review |
| `PR Reviewer: Clear All Review Decorations` | Remove all inline highlights |
