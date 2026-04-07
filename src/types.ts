export interface ReviewFinding {
    /** The file path (relative to repo root) the finding is about. */
    file: string;
    /** 1-based line number in the file. -1 means no specific line. */
    line: number;
    /** Severity of the finding. */
    severity: 'error' | 'warning' | 'info';
    /** Short one-liner title. */
    title: string;
    /** Detailed message in the reviewer's persona style. */
    message: string;
    /** Suggested fix, if any. */
    suggestion?: string;
}
