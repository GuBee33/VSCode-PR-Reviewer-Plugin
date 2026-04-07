import * as vscode from 'vscode';

type CharacterState = 'idle' | 'thinking' | 'talking' | 'laughing' | 'error' | 'done';

const STATE_CONFIG: Record<CharacterState, { icon: string; defaultText: string }> = {
    idle:     { icon: '$(person)',            defaultText: 'PR Reviewer: Idle' },
    thinking: { icon: '$(sync~spin)',         defaultText: 'Reviewing…' },
    talking:  { icon: '$(comment-discussion)', defaultText: 'Reviewing…' },
    laughing: { icon: '$(smiley)',            defaultText: 'Review complete' },
    error:    { icon: '$(error)',             defaultText: 'Review failed' },
    done:     { icon: '$(check)',             defaultText: 'Review complete' },
};

/**
 * Manages a status bar item in the bottom-left corner that shows
 * the current review state with an animated icon.
 */
export class StatusBarCharacter implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            10_000 // high priority → far left
        );
        this.item.command = 'prReviewer.characterView.focus';
        this.setState('idle');
        this.item.show();
    }

    setState(state: CharacterState, text?: string): void {
        const cfg = STATE_CONFIG[state];
        this.item.text = `${cfg.icon} ${text ?? cfg.defaultText}`;

        // Use colour cues for error / done states
        if (state === 'error') {
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (state === 'done') {
            this.item.backgroundColor = undefined;
        } else {
            this.item.backgroundColor = undefined;
        }

        this.item.tooltip = text ?? cfg.defaultText;
    }

    dispose(): void {
        this.item.dispose();
    }
}
