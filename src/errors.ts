/**
 * Exit codes are part of Mora's contract with agents: an agent needs to tell
 * "you asked for something impossible" apart from "the tool broke".
 */
export const ExitCode = {
  ok: 0,
  failure: 1,
  usage: 2,
  conflict: 3,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class MoraError extends Error {
  readonly code: string;
  readonly exitCode: ExitCodeValue;
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { code: string; exitCode?: ExitCodeValue; hint?: string } = { code: 'unknown' },
  ) {
    super(message);
    this.name = 'MoraError';
    this.code = options.code;
    this.exitCode = options.exitCode ?? ExitCode.failure;
    this.hint = options.hint;
  }
}

export function toMoraError(error: unknown): MoraError {
  if (error instanceof MoraError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new MoraError(message, { code: 'unexpected' });
}
