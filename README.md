# PR Reviewer – Copilot Edition 🎬

A VS Code extension that reviews your pull request diff using **GitHub Copilot**, narrated by an animated character with a choice of reviewer personalities.

---

## Features

| Feature | Description |
|---|---|
| 🤖 **Copilot-powered review** | Uses the VS Code Language Model API to send your branch diff to Copilot and get back structured findings |
| 🧍 **Animated sidebar character** | Your character lives in the Activity Bar — idle while waiting, walking while reviewing |
| 🔴🟡🔵 **Inline decorations** | Findings are highlighted directly in your editor with coloured gutters and hover tooltips |
| ⚙️ **Configurable persona** | Choose from multiple built-in reviewer personalities (sarcastic, encouraging, formal…) |
| 🌐 **Response language** | Pick any of 65+ supported languages for findings output — default English, Hungarian and many others included |
| 📋 **Findings panel** | All findings listed in the sidebar; click any to jump to the relevant file and line |
| ✨ **Fix with Copilot** | One-click to send a finding (or all findings) to GitHub Copilot Chat for an automated fix |
| 📊 **Status bar indicator** | Bottom-left corner shows live review progress and a summary when done |

---

## Requirements

- VS Code **1.90** or later
- **GitHub Copilot** extension installed and authenticated

---

## Usage

1. Open a Git repository in VS Code
2. Click the **PR Reviewer** icon in the Activity Bar (left navigation)
3. Configure the review in the sidebar panel:
   - **Compare Against** — pick the branch to diff against
   - **Model** — choose the Copilot model
   - **Reviewer Personality** — pick a personality (Sarcastic Cynic, Boring Senior Developer, The Politician…)
   - **Response Language** — select the language for all findings (default: English)
   - **Extra Instructions** — optionally add free-text instructions for the review
4. Click **Start Review** — or run **`PR Reviewer: Review Current PR / Branch Diff`** from the Command Palette (`Ctrl+Shift+P`)
5. Watch your character walk while Copilot reviews the diff
6. Findings appear in the sidebar and are highlighted inline in your editor
7. Click any finding to jump to the relevant file and line, or use **✨ Fix with Copilot** to send it to Copilot Chat

---

## Sidebar Controls

The sidebar panel exposes the following controls before starting a review:

| Control | Description |
|---|---|
| **Compare Against** | Branch to diff against (defaults to current branch uncommitted changes) |
| **Model** | Copilot language model to use |
| **Reviewer Personality** | Character persona for the review narration |
| **Response Language** | Language for all findings, titles, and suggestions (default: English). The list of supported languages is provided by the extension and validated server-side — arbitrary values are rejected and fall back to English. |
| **Extra Instructions** | Free-text instructions appended to the review prompt |

---

## Sidebar Toolbar

| Button | Action |
|---|---|
| ▶ | Start a review |
| ⟳ | Reset the panel to its initial state |
| ⚙ | Open PR Reviewer settings |

---

## Configuration

Open settings via the **⚙ gear icon** in the sidebar toolbar, or go to **File → Preferences → Settings** and search `prReviewer`.

| Setting | Default | Description |
|---|---|---|
| `prReviewer.customIdleSprite` | `""` | Path to a custom PNG sprite sheet for the idle animation |
| `prReviewer.customWorkSprite` | `""` | Path to a custom PNG sprite sheet for the working animation |
| `prReviewer.idleSpriteRows` / `idleSpriteCols` | `5` | Grid dimensions of the idle sprite sheet |
| `prReviewer.workSpriteRows` / `workSpriteCols` | `5` | Grid dimensions of the work sprite sheet |
| `prReviewer.debugOutput` | `false` | Enable verbose debug output in the *PR Reviewer* output channel |

> **Reviewer personality**, **model**, **base branch**, **extra instructions**, and **response language** are all configured directly in the sidebar panel and are persisted automatically across VS Code sessions — no `settings.json` edits needed.

Example `settings.json` (sprite customisation only):

```json
"prReviewer.customIdleSprite": "C:/sprites/my-idle.png",
"prReviewer.idleSpriteRows": 4,
"prReviewer.idleSpriteCols": 4
```

---

## Installation

### Option 1 — Build and install in one step (recommended)

Requires Node.js, npm, and VS Code on your PATH.

**Windows (PowerShell):**
```powershell
.\build_and_install.ps1
```

**Linux / macOS:**
```bash
./build_and_install.sh
```

This compiles the TypeScript, packages a `.vsix`, and installs it directly into your VS Code extensions folder.

Then reload VS Code: `Ctrl+Shift+P` → **Developer: Reload Window**.

---

### Option 2 — Build the VSIX, then install manually from VS Code

**Step 1 – build the VSIX:**

```powershell
.\build.ps1          # Windows
```
```bash
./build.sh           # Linux / macOS
```

This produces a file like `pr-reviewer-1.0.0.vsix` in the repo root.

**Step 2 – install from VS Code:**

- Open the Extensions view (`Ctrl+Shift+X`)
- Click the **`…`** menu (top-right of the Extensions panel)
- Select **Install from VSIX…**
- Browse to the generated `.vsix` file and confirm

Then reload VS Code: `Ctrl+Shift+P` → **Developer: Reload Window**.

---

### Option 3 — Install a pre-built VSIX from the command line

If you already have a `.vsix` file:

```powershell
.\install.ps1        # Windows
```
```bash
./install.sh         # Linux / macOS
```

Or directly via the VS Code CLI:

```bash
code --install-extension pr-reviewer-1.0.0.vsix
```

---

### Development loop

```powershell
npm install
npm run compile   # one-shot build
npm run watch     # watch mode (recompiles on save)
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

