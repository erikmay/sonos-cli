import { parseArgs } from "node:util";
import { SonosError } from "./soap.ts";

export class UsageError extends SonosError {}

export type OptionDefinitions = Record<string, { type: "boolean" | "string"; short?: string }>;
export type ArgumentCount = readonly [min: number, max: number];

export interface Action<Context> {
  /** Positional argument count. Without it, the action takes no arguments. */
  args?: ArgumentCount;
  run: (ctx: Context, args: string[]) => Promise<void>;
}

interface CommandInfo {
  names: string[];
  usage: string;
  help: string;
  options?: OptionDefinitions;
}

/** With subcommands, the first argument selects the action. The first subcommand is the default. */
export type Command<Context> = CommandInfo & (Action<Context> | { subcommands: Record<string, Action<Context>> });

const GLOBAL_OPTIONS: OptionDefinitions = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  refresh: { type: "boolean" },
  speaker: { type: "string", short: "s" },
};

export function parseArguments(argv: string[], commands: CommandInfo[]) {
  const definitions: OptionDefinitions = Object.assign({}, GLOBAL_OPTIONS, ...commands.map((c) => c.options));
  try {
    // Numeric operands must keep their sign without being parsed as short options.
    const parsed = parseArgs({
      args: argv.map((arg) => /^-(?:\d+(?:\.\d*)?|\.\d+)$/.test(arg) ? arg.slice(1) : arg),
      options: definitions,
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
    const flags = new Set<string>();
    const options = new Map<string, string>();
    const positional: string[] = [];
    for (const token of parsed.tokens) {
      if (token.kind === "positional") positional.push(argv[token.index]!);
      else if (token.kind === "option") {
        if (token.value === undefined) flags.add(token.name);
        else {
          const value = token.inlineValue ? token.value : argv[token.index + 1]!;
          if (!value) throw new UsageError(`Option --${token.name} needs a value`);
          options.set(token.name, value);
        }
      }
    }
    return { flags, options, positional };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** Checks the options and the argument count, and returns the action with its arguments. */
export function resolveAction<Context>(command: Command<Context>, args: string[], supplied: Iterable<string>): [Action<Context>, string[]] {
  for (const name of supplied) {
    if (!Object.hasOwn(GLOBAL_OPTIONS, name) && !Object.hasOwn(command.options ?? {}, name)) {
      throw new UsageError(`Option --${name} is not supported by "${command.names[0]}"`);
    }
  }
  let action: Action<Context>;
  if ("subcommands" in command) {
    const [name = Object.keys(command.subcommands)[0]!, ...rest] = args;
    const subcommand = Object.hasOwn(command.subcommands, name) ? command.subcommands[name] : undefined;
    if (!subcommand) throw new UsageError(`Unknown ${command.names[0]} command: ${name}`);
    [action, args] = [subcommand, rest];
  } else {
    action = command;
  }
  const [min, max] = action.args ?? [0, 0];
  if (args.length < min || args.length > max) throw new UsageError(`Usage: sonos ${command.usage}`);
  // An empty name must not match the first favorite or room.
  if (args.some((arg) => !arg.trim())) throw new UsageError(`Empty argument. Usage: sonos ${command.usage}`);
  return [action, args];
}
