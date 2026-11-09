import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { delimiter, dirname } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function nodeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  environment.PATH = `${dirname(process.execPath)}${delimiter}${environment.PATH ?? ''}`;
  return environment;
}

function commandOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (error === null || typeof error !== 'object') return '';
  const value: unknown = Reflect.get(error, key);
  return typeof value === 'string' ? value : '';
}

export async function runLoggedProcess(
  command: string,
  args: string[],
  cwd: string,
  log: string,
  environment: NodeJS.ProcessEnv,
  timeout: number,
): Promise<{ stdout: string; stderr: string; wallMs: number }> {
  let stdout = '';
  let stderr = '';
  const start = performance.now();
  try {
    const result = await exec(command, args, {
      cwd,
      env: environment,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    const wallMs = performance.now() - start;
    stdout = result.stdout;
    stderr = result.stderr;
    return { stdout, stderr, wallMs };
  } catch (error) {
    stdout = commandOutput(error, 'stdout');
    stderr = commandOutput(error, 'stderr');
    throw error;
  } finally {
    await writeFile(`${log}.stdout.log`, stdout, { flag: 'wx' });
    await writeFile(`${log}.stderr.log`, stderr, { flag: 'wx' });
  }
}

export async function runLogged(
  command: string,
  args: string[],
  cwd: string,
  log: string,
  environment: NodeJS.ProcessEnv,
  timeout: number,
): Promise<string> {
  return (await runLoggedProcess(command, args, cwd, log, environment, timeout))
    .stdout;
}
