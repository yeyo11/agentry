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
| matcher | el matcher (of a hook) |
| commit | el commit; "hacer commit", "sin commit" |
| pull request, PR | la pull request, la PR |
| compact | "compactar" is fine as a verb in prose; `/compact` stays literal |
| wrapper | el wrapper (Agentry's server) |
| worker | el worker, los workers (the runs an orchestration launches; Agentry's own term, kept short) |
| stream | el stream (a run's live event feed): "Stream conectado" |
| CLI | **el** CLI, never "la CLI": "el CLI no la valida", "session de CLI" |
| permission prompt | la petición de permiso — never "prompt", which is only what a person sends to Claude |

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
| Template | Plantilla |
| Re-run (a task) / Relaunch (a graph) | Repite / Relanza |
| Connector | Conector |
| Rotation policy | Política de rotación |
| Config directory | Directorio de configuración |
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
| Scope values `user`, `project`, `local` (MCP servers, plugins) | untranslated: they are the CLI's `--scope` values |
| Files / File | Archivos / Archivo |
| Folder / Directory | Carpeta / Directorio |
| Path | Ruta |
| Commands (the `commands/` resource) | Comandos |
| Rules | Reglas |
| Instructions | Instrucciones |
| Credential / API key | Credencial / Clave de API |
| Template | Plantilla |
| Browse (plugins) | Explorar |
| Installed | Instalado(s) |
| Task (of an orchestration) | Tarea |
| Planner | Planificador |
| Engine: graph / workflow | Motor: grafo / workflow |
| Stage | Etapa |
| Integration, merge | Integración, fusionar |
| Push (a branch) | Subir |
| Auto-rotation | Rotación automática |
| Threshold | Umbral |
| Language | Idioma |
| Theme: system / light / dark | Tema del sistema / claro / oscuro |
| Workspace (the wrapper's) | Espacio de trabajo |
| Working directory | Directorio de trabajo |
| Default (value) | Predeterminado |
| Background (a task, a subagent) | segundo plano: "Tareas en segundo plano", tag "segundo plano" |
| Logged in / logged out (Claude Code auth) | sesión iniciada / sesión cerrada (the login, not a `session`) |
| Board (orchestration) | Tablero |
| Details / Output | Detalles / Salida |
| Result | Resultado |
| Tool result / Tool error | Resultado de la herramienta / Error de la herramienta |
| Turn | Turno |
| Decline (a question) | Rechaza |
| Previous | Anterior |
| Clear (a list) | Vacía |
| Mark all read | Márcalas todas como leídas |
| Toast | aviso emergente |
| Live | en directo ("Runs en directo"), never "activo", which translates *active* |
| Theme names | Tema del sistema / Tema claro / Tema oscuro |
| Notification kinds (what to notify about) | a plural noun phrase after "Avísame de": "Runs que me esperan" |

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

## The chat model

Terms of the chats redesign. Like the CLI's, most stay in English.

| English | Spanish |
|---|---|
| chat | el chat, los chats: "Nuevo chat", "Chats en curso" |
| execution (of a chat) | la ejecución, las ejecuciones |
| fork (a chat) | el fork; "Crea un fork" |
| health (of a chat) | la salud |
| signal (of health) | la señal |
| state: working / waiting / idle | trabajando / esperando / inactivo |
| outcome: completed / failed / stopped / interrupted | completada / fallida / detenida / interrumpida (of an execution, feminine) |
| loose (a chat under no project) | suelto: "chats sueltos" |
| control: interactive / resumable / read-only | interactivo / reanudable / solo lectura |
| hint (sent to a worker) | la pista, las pistas |
| blocked (a task waiting for a decision) | bloqueada |
| retry clean | reintento limpio |
| give up (a branch) | descartar la rama |
| context (window) | el contexto |
| home (page) | Inicio |
| inbox | la bandeja |
| resource (agents, skills, commands…) | el recurso |

More terms of the chats redesign, as the screens use them.

| English | Spanish |
|---|---|
| Waiting for you | Esperándote (a list of what needs a person: "Te esperan") |
| Pick up again | Retomar |
| Right now | Ahora mismo |
| Health levels OK / Warning / Problem | Correcto / Advertencia / Problema |
| held (a synthesis waiting on a decision) | retenido |
| attempt | el intento: "Fallida tras 2 intentos" |
| Skip (give up) a branch | Descarta la rama |
| Purge (the state Claude Code keeps) | Purga |
| Rename | Renombra |
| adopted (chats) | adoptados |
| blocked | *bloqueada* for a task (feminine), `bloqueado` in the generic status badge |
