#!/usr/bin/env node
import { auditProject, runProject } from './project.js';
import type { OutputWarning } from './outputs.js';

function reportWarning(warning: OutputWarning): void {
  process.stderr.write(
    `POM warning [${warning.code}]: ${warning.path}: ${warning.message}\n`,
  );
}

const usage = 'Usage: pom <generate|check|audit> --config <path>\n';
const args = process.argv.slice(2);
if (
  args.length === 0 ||
  (args.length === 1 && ['--help', '-h'].includes(args[0]!))
) {
  process.stdout.write(usage);
} else {
  const [command, flag, configPath] = args;
  if (
    (command !== 'generate' && command !== 'check' && command !== 'audit') ||
    flag !== '--config' ||
    !configPath ||
    args.length !== 3
  ) {
    process.stderr.write(usage);
    process.exitCode = 2;
  } else {
    try {
      if (command === 'audit') {
        const result = await auditProject(configPath);
        for (const warning of result.warnings) reportWarning(warning);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exitCode = result.clean ? 0 : 1;
      } else {
        const result = await runProject(configPath, {
          check: command === 'check',
          onWarning: reportWarning,
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
      }
    } catch (error) {
      process.stderr.write(
        `POM: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
