import { parseArgs as nodeParseArgs } from "node:util";
import { AxiError } from "axi-sdk-js";

/**
 * Strict per-command argument parsing (AXI principle 6: fail loud on
 * unrecognized input). Every command declares its own flag set; an unknown
 * flag is rejected by name with the valid flags listed inline so the agent
 * self-corrects in one turn.
 */

export interface PositionalSpec {
  name: string;
  required?: boolean;
  /** Greedy: consumes all remaining positionals. */
  variadic?: boolean;
}

export interface CommandArgSpec {
  /** Flags that take a string value, e.g. `--limit 50`. */
  string?: string[];
  /** Boolean flags, e.g. `--confirm`. */
  boolean?: string[];
  /** String flags whose value must parse as a non-negative integer. */
  number?: string[];
  defaults?: Record<string, string | boolean | number>;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | number>;
}

/** Flags accepted by every command in addition to its own set. */
export const GLOBAL_FLAGS: Readonly<{ string: string[] }> = {
  string: ["daemon-url", "data-dir"],
};

export function parseCommandArgs(
  argv: string[],
  spec: CommandArgSpec,
  positionals: PositionalSpec[] | undefined,
  commandPath: string,
): ParsedArgs {
  const options: Record<string, { type: "string" | "boolean" }> = {};
  for (const name of [...(spec.string ?? []), ...GLOBAL_FLAGS.string]) {
    options[name] = { type: "string" };
  }
  for (const name of spec.boolean ?? []) {
    options[name] = { type: "boolean" };
  }
  for (const name of spec.number ?? []) {
    options[name] = { type: "string" };
  }

  let parsed;
  try {
    parsed = nodeParseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = /unknown option|Unexpected\s+([\w-]+)?/i.test(message);
    if (unknown) {
      throw unknownFlagError(commandPath, options, message);
    }
    throw new AxiError(
      `${commandPath}: ${message}`,
      "VALIDATION_ERROR",
      [`Run \`open-design-axi ${commandPath} --help\` for usage`],
    );
  }

  const flags: Record<string, string | boolean | number> = { ...(spec.defaults ?? {}) };
  for (const [key, value] of Object.entries(parsed.values)) {
    if (value === undefined) continue;
    if (spec.number?.includes(key)) {
      const raw = String(value);
      if (!/^\d+$/.test(raw)) {
        throw new AxiError(
          `--${key} must be a non-negative integer, got "${raw}"`,
          "VALIDATION_ERROR",
          [`Run \`open-design-axi ${commandPath} --help\` for usage`],
        );
      }
      flags[key] = Number(raw);
    } else {
      flags[key] = value as string | boolean;
    }
  }

  const pos = parsed.positionals ?? [];
  if (positionals?.length) {
    const required = positionals.filter((p) => p.required);
    if (pos.length < required.length) {
      const missing = required
        .slice(Math.min(pos.length, required.length))
        .map((p) => `<${p.name}>`);
      throw new AxiError(
        `missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(" ")}`,
        "VALIDATION_ERROR",
        [
          `Run \`open-design-axi ${commandPath} ${positionals.map((p) => `<${p.name}>`).join(" ")}\``,
        ],
      );
    }
    const maxSlots = positionals.filter((p) => !p.variadic).length + (positionals.some((p) => p.variadic) ? Infinity : 0);
    if (!positionals.some((p) => p.variadic) && pos.length > maxSlots) {
      throw new AxiError(
        `unexpected extra argument: ${pos[pos.length - 1]}`,
        "VALIDATION_ERROR",
        [
          `Run \`open-design-axi ${commandPath} ${positionals.map((p) => `<${p.name}>`).join(" ")}\``,
        ],
      );
    }
  } else if (pos.length > 0) {
    throw new AxiError(
      `unexpected argument: ${pos[0]}`,
      "VALIDATION_ERROR",
      [`Run \`open-design-axi ${commandPath} --help\` to see usage`],
    );
  }

  return { positionals: pos, flags };
}

export function unknownFlagError(
  commandPath: string,
  options: Record<string, unknown>,
  detail: string,
): AxiError {
  const flagMatch = /"--?([\w-]+)"/.exec(detail);
  const name = flagMatch?.[1];
  const valid = [
    ...Object.keys(options).sort().map((k) => `--${k}`),
    "--help",
  ];
  return new AxiError(
    `unknown flag ${name ? `--${name}` : ""} for \`${commandPath}\``.replace("  ", " ").trim(),
    "VALIDATION_ERROR",
    [
      `valid flags for \`${commandPath}\`: ${valid.join(", ")}`,
      `Run \`open-design-axi ${commandPath} --help\` for usage`,
    ],
  );
}

export function requireFlagString(
  flags: Record<string, string | boolean | number>,
  name: string,
  commandPath: string,
): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new AxiError(
      `--${name} is required`,
      "VALIDATION_ERROR",
      [`Run \`open-design-axi ${commandPath} --${name} <${name}>\``],
    );
  }
  return value;
}
