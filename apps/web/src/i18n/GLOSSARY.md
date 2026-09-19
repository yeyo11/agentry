# Spanish glossary

The reference for every Spanish string in `locales/es/`. When a term is missing, add it here in the
same change that first uses it, rather than picking a second translation.

How to add a key and use it is documented at the top of [index.ts](index.ts).

## Rules

- **Spain's Spanish, informal "tú"**: "Guarda los cambios", "¿Seguro que quieres eliminar este run?",
  "Tu cuenta". Never "usted", never Latin American forms ("computadora", "celular", "costo").
- **Actions (buttons, menu items) use the imperative with "tú"**: Guarda, Envía, Elimina, Cancela.
  Headings, tab names and field labels are nouns or infinitives: "Ajustes", "Cambios sin guardar".
- **Sentence case**, as Spanish writes it: "Tareas en segundo plano", not "Tareas En Segundo Plano".
- **Punctuation**: opening `¿` and `¡`; the ellipsis character `…` as in English; the same quotes the
  English string uses.
- **Numbers, dates, durations, sizes and costs** never go into a translation by hand: pass them
  through `lib/format` (formatDuration, timeAgo, formatNumber, formatCost…) and interpolate the
  result, so Spanish gets `1.500`, `2 h 5 min`, `hace 5 min`, `1,50 US$`.
- **Never translated**: anything that comes from the CLI, from Claude or from the user (transcripts,
  tool names, file contents, error messages from the API), and literal names: slash commands
  (`/compact`), flags (`--model`), setting keys, permission mode values (`acceptEdits`, `plan`),
  model names, file names (`CLAUDE.md`, `settings.json`), environment variables, product names
  (Claude Code, Agentry, claude-swap).

## Kept as in the CLI

Claude Code calls these by their English name, so the Spanish UI does too and reads the same as the
terminal. They take the article and gender shown, and form the plural with `-s`.

| Term | In a Spanish sentence |
|---|---|
| run | el run, los runs: "Detén el run", "3 runs activos" |
| session | la session, las sessions: "Reanuda la session" |
| subagent | el subagent, los subagents |
| worktree | el worktree, los worktrees |
| prompt | el prompt, los prompts |
| system prompt | el system prompt |
| hook | el hook, los hooks |
| MCP, MCP server | el servidor MCP, los servidores MCP |
| skill | la skill, las skills |
| plugin | el plugin, los plugins |
| marketplace | el marketplace |
| workflow | el workflow, los workflows |
| token | el token, los tokens |
| slash command | el slash command |
| output style | el output style |
| thinking, extended thinking | el thinking, el extended thinking |
| effort | el effort (the `--effort` level), its values untranslated |
| compact | "compactar" is fine as a verb in prose; `/compact` stays literal |
| wrapper | el wrapper (Agentry's server) |
| worker | el worker (one agent of an orchestration): "Worker de una orquestación" |

## Recurring UI words

| English | Spanish |
|---|---|
| Save | Guarda |
| Cancel | Cancela |
| Delete | Elimina |
| Remove | Quita |
| Edit | Edita |
| Close | Cierra |
| Open | Abre |
| Add | Añade |
| Create | Crea |
| New run | Nuevo run |
| New (feminine noun) | Nueva |
| Send | Envía |
| Stop | Detén |
| Resume | Reanuda |
| Retry | Reintenta |
| Refresh | Actualiza |
| Copy / Copied | Copia / Copiado |
| Search | Busca (action), Búsqueda (field / heading) |
| Filter | Filtra (action), Filtro (heading) |
| Approve / Deny | Aprueba / Deniega |
| Allow | Permite |
| Install / Uninstall | Instala / Desinstala |
| Enable / Disable | Activa / Desactiva |
| Enabled / Disabled | Activado / Desactivado |
| Discard | Descarta |
| Reset | Restablece |
| Apply | Aplica |
| Confirm | Confirma |
| Back / Next | Volver / Siguiente |
| Show more / Show less | Mostrar más / Mostrar menos |
| Loading… | Cargando… |
| Connecting… | Conectando… |
| Unsaved changes | Cambios sin guardar |
| Are you sure you want to …? | ¿Seguro que quieres …? |
| Dashboard | Panel |
| Agents | Agentes |
| Background tasks | Tareas en segundo plano |
| Projects / Project | Proyectos / Proyecto |
| Orchestration | Orquestación |
| Accounts / Account | Cuentas / Cuenta |
| Memory | Memoria |
| Config | Configuración |
| Settings | Ajustes |
| API reference | Referencia de la API |
| Notifications | Notificaciones |
| Command palette | Paleta de comandos |
| Tool | herramienta (the tool's own name, `Bash`, `Edit`, untranslated) |
| Permission / Permission mode | Permiso / Modo de permisos |
| Model | Modelo |
| Usage | Uso |
| Cost | Coste |
| Duration | Duración |
| Transcript | Transcripción |
| Attachment | Adjunto |
| Branch | Rama |
| Scope: user / project | Ámbito: usuario / proyecto |
| Language | Idioma |
| Theme: system / light / dark | Tema del sistema / claro / oscuro |
| Output (of a task or tool) | Salida |
| Result | Resultado |
| Tool result / Tool error | Resultado de la herramienta / Error de la herramienta |
| Turn | Turno |
| Decline (a question) | Rechaza |
| Previous | Anterior |
| Clear (a list) | Vacía |
| Mark all read | Márcalas todas como leídas |
| Toast | aviso emergente |
| Background (a subagent's) | segundo plano |

## Status names

Statuses describe a run (masculine), so adjectives agree with "el run". They live in
`common:status.*` and every badge goes through `statusText()` in components/ui.tsx; a status Agentry
does not know is shown as it came. MCP server states (`connected`, `needs-auth`…) come from the CLI
and stay untranslated.

| English | Spanish |
|---|---|
| starting | iniciando |
| busy | trabajando |
| running | en curso |
| pending | pendiente |
| success | correcto |
| killed | abortado |
| stopped | detenido |
| skipped | omitido |
| merging / merged | fusionando / fusionado |
| resolving | resolviendo |
| conflicted | en conflicto |
| unknown | desconocido |
| queued | en cola |
| waiting | esperando |
| completed | completado |
| failed | fallido |
| cancelled | cancelado |
| interrupted | interrumpido |
| idle | inactivo |
| live | en directo |
| active | activo |
| error | error |
