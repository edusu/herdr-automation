// Every sh and git command line of the mod lives here: the platform seam (macOS and Linux).
// User values are passed as positional arguments ("$1", "$2"), never pasted into the line.

/**
 * The argv of a script Run's tab: `command` runs through sh in its own process, so an `exit`
 * in it ends only itself, and its exit code is then written to `exitFile` for the engine.
 */
export const scriptArgv = (command, exitFile) =>
  ["sh", "-c", 'sh -c "$1"; printf "%s" "$?" > "$2"', "sh", command, exitFile];
