`GH_TOKEN`, `GITHUB_TOKEN` (in order of precedence): an authentication token that will be used when
a command targets either `github.com` or a subdomain of `ghe.com`. Setting this avoids being prompted to
authenticate and takes precedence over previously stored credentials.

`GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` (in order of precedence): an authentication
token that will be used when a command targets a GitHub Enterprise Server host.

`GH_HOST`: specify the GitHub hostname for commands where a hostname has not been provided, or
cannot be inferred from the context of a local Git repository. If this host was previously
authenticated with, the stored credentials will be used. Otherwise, setting `GH_TOKEN` or
`GH_ENTERPRISE_TOKEN` is required, depending on the targeted host.

`GH_REPO`: specify the GitHub repository in the `[HOST/]OWNER/REPO` format for commands
that otherwise operate on a local repository.

`GH_EDITOR`, `GIT_EDITOR`, `VISUAL`, `EDITOR` (in order of precedence): the editor tool to use
for authoring text.

`GH_BROWSER`, `BROWSER` (in order of precedence): the web browser to use for opening links.

`GH_DEBUG`: set to a truthy value to enable verbose output on standard error. Set to `api`
to additionally log details of HTTP traffic.

`DEBUG` (deprecated): set to `1`, `true`, or `yes` to enable verbose output on standard
error.

`GH_PAGER`, `PAGER` (in order of precedence): a terminal paging program to send standard output
to, e.g. `less`.

`GLAMOUR_STYLE`: the style to use for rendering Markdown. See
<https://github.com/charmbracelet/glamour#styles>

`NO_COLOR`: set to any value to avoid printing ANSI escape sequences for color output.

`CLICOLOR`: set to `0` to disable printing ANSI colors in output.

`CLICOLOR_FORCE`: set to a value other than `0` to keep ANSI colors in output
even when the output is piped.

`GH_COLOR_LABELS`: set to any value to display labels using their RGB hex color codes in terminals that
support truecolor.

`GH_ACCESSIBLE_COLORS` (preview): set to a truthy value to use customizable, 4-bit accessible colors.

`GH_FORCE_TTY`: set to any value to force terminal-style output even when the output is
redirected. When the value is a number, it is interpreted as the number of columns
available in the viewport. When the value is a percentage, it will be applied against
the number of columns available in the current viewport.

`GH_NO_UPDATE_NOTIFIER`: set to any value to disable GitHub CLI update notifications.
When any command is executed, gh checks for new versions once every 24 hours.
If a newer version was found, an upgrade notice is displayed on standard error.

`GH_NO_EXTENSION_UPDATE_NOTIFIER`: set to any value to disable GitHub CLI extension update notifications.
When an extension is executed, gh checks for new versions for the executed extension once every 24 hours.
If a newer version was found, an upgrade notice is displayed on standard error.

`GH_EXTENSION`: set to `1` by gh when it invokes an extension, allowing an extension to
tell whether it was run as `gh <extension>` or directly as a standalone program.

`GH_CONFIG_DIR`: the directory where gh will store configuration files. If not specified,
the default value will be one of the following paths (in order of precedence):
  - `$XDG_CONFIG_HOME/gh` (if `$XDG_CONFIG_HOME` is set),
  - `$AppData/GitHub CLI` (on Windows if `$AppData` is set), or
  - `$HOME/.config/gh`.

`GH_PROMPT_DISABLED`: set to any value to disable interactive prompting in the terminal.

`GH_PATH`: set the path to the gh executable, useful for when gh can not properly determine
its own path such as in the cygwin terminal. gh also sets this when invoking extensions so they
can call back into the same gh executable.

`GH_MDWIDTH`: default maximum width for markdown render wrapping.  The max width of lines
wrapped on the terminal will be taken as the lesser of the terminal width, this value, or 120 if
not specified.  This value is used, for example, with `pr view` subcommand.

`GH_ACCESSIBLE_PROMPTER` (preview): set to a truthy value to enable prompts that are
more compatible with speech synthesis and braille screen readers.

`GH_TELEMETRY`: set to `log` to print telemetry data to standard error instead of sending it.
Set to `false` or `0` to disable telemetry. Takes precedence over `DO_NOT_TRACK`.

`DO_NOT_TRACK`: set to `true` or `1` to disable telemetry. Ignored when
`GH_TELEMETRY` is set, which takes precedence.

`GH_SPINNER_DISABLED`: set to a truthy value to replace the spinner animation with
a textual progress indicator.
