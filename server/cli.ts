import { defaultConfig, resolveBind } from './config.js';

export interface CliOptions {
  configPath?: string;
  bind?: string;
  headless: boolean;
  browser: boolean;
  updateRestart: boolean;
  help: boolean;
  version: boolean;
}

export function parseCliArgs(args: string[]): CliOptions {
  const result: CliOptions = { headless: false, browser: false, updateRestart: false, help: false, version: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const equals = argument.indexOf('=');
    const name = equals < 0 ? argument : argument.slice(0, equals);
    if (name === '--config' || name === '--bind') {
      const inline = equals >= 0;
      const value = inline ? argument.slice(equals + 1) : args[++index];
      if (!value?.trim() || value.includes('\0') || (!inline && value.startsWith('-'))) throw new Error(`${name} requires a value.`);
      if (seen.has(name)) throw new Error(`${name} may only be specified once.`);
      seen.add(name);
      if (name === '--config') result.configPath = value;
      else { resolveBind(defaultConfig(), value); result.bind = value; }
    } else if (argument === '--headless') result.headless = true;
    else if (argument === '--browser' || argument === '--open') result.browser = true;
    else if (argument === '--update-restart') result.updateRestart = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--version' || argument === '-v') result.version = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return result;
}
