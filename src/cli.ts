import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { registerDescribeCommand } from './commands/describe.js';
import { registerInitCommand } from './commands/init.js';
import { registerQueryCommand } from './commands/query.js';
import { registerValidateCommand } from './commands/validate.js';
import { ExitCode, type MoraError, toMoraError } from './errors.js';

const requirePackage = createRequire(import.meta.url);
const pkg = requirePackage('../package.json') as { version: string; description: string };

function buildProgram(): Command {
  const program = new Command();

  program
    .name('mora')
    .description(
      `${pkg.description}\n\n` +
        'Mora is built to be driven by a coding agent. Every command accepts flags for\n' +
        'unattended use and --json for machine-readable output.',
    )
    .version(pkg.version, '-v, --version')
    .showHelpAfterError()
    .configureOutput({
      outputError: (message, write) => write(pc.red(message)),
    });

  registerInitCommand(program);
  registerValidateCommand(program);
  registerDescribeCommand(program);
  registerQueryCommand(program);

  return program;
}

async function main(argv: string[]): Promise<void> {
  const program = buildProgram();

  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(argv);
}

const wantsJson = process.argv.includes('--json');

try {
  await main(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    // Commander already reported the problem and chose an exit code.
    process.exit(error.exitCode);
  }
  reportFailure(toMoraError(error));
}

function reportFailure(error: MoraError): never {
  if (wantsJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: { code: error.code, message: error.message, hint: error.hint ?? null },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stderr.write(`${pc.red('error')} ${error.message}\n`);
    if (error.hint) {
      process.stderr.write(`${pc.dim(error.hint)}\n`);
    }
  }
  process.exit(error.exitCode ?? ExitCode.failure);
}
