#!/usr/bin/env node
import { runProject } from './project.js';

const usage = 'Usage: pom <generate|check> --config <path>\n';
const args = process.argv.slice(2);
if (
  args.length === 0 ||
  (args.length === 1 && ['--help', '-h'].includes(args[0]!))
) {
  process.stdout.write(usage);
} else {
  const [command, flag, configPath] = args;
  if (
    (command !== 'generate' && command !== 'check') ||
    flag !== '--config' ||
    !configPath ||
    args.length !== 3
  ) {
    process.stderr.write(usage);
    process.exitCode = 2;
  } else {
    try {
      const result = await runProject(configPath, {
        check: command === 'check',
      });
      if (command === 'check' && !result.clean) {
        process.stderr.write(
          `Generated output drift:\n${result.changes.map((change) => `  ${change}`).join('\n')}\n`,
        );
        process.exitCode = 1;
      } else {
        process.stdout.write(
          `${command === 'check' ? 'Verified' : 'Generated'} ${result.output}\n`,
        );
      }
    } catch (error) {
      process.stderr.write(
        `POM: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
