# Spanish glossary

The reference for every Spanish string in `locales/es/`. When a term is missing, add it here in the
same change that first uses it, rather than picking a second translation.

How to add a key and use it is documented at the top of [index.ts](index.ts).

This revision rewrites the glossary against [docs/plans/spanish-copy.md](../../../../docs/plans/spanish-copy.md),
after reading every string in `locales/en/` and `locales/es/`. The "Terms that changed" section at
the bottom lists every old form next to its replacement, so the tasks that rewrite the locale files
can search for it.

## Rules

- **Spain's Spanish, informal "tú"**: "Guarda los cambios" → "Guardar los cambios" is wrong on both
  counts — see the next rule — but the address is right: "¿Seguro que quieres eliminar esta
  ejecución?", "Tu cuenta". Never "usted", never Latin American forms ("computadora", "celular",
  "costo").
- **Buttons, menu items, links and any other clickable action use the infinitive**, not the
  imperative: "Guardar", "Cancelar", "Eliminar", "Reanudar", "Enviar ahora", "Copiar el id del
  chat", "Exportar Markdown", "Ordenar por", "Filtrar por". This is what Windows, macOS, Android and
  Google write in Spanish, and it is already how some of this app's own strings read
  (`chat.json`'s `copyId` and `cancelFork` are infinitive; `export.markdown` a few lines away is not
  — that mismatch is exactly what this rule fixes). Headings, tab names and field labels stay nouns:
  "Ajustes", "Cambios sin guardar", "Búsqueda".
- **Sentence case**, as Spanish writes it: "Tareas en segundo plano", not "Tareas En Segundo Plano".
- **Punctuation**: opening `¿` and `¡`; the ellipsis character `…` as in English; the same quotes the
  English string uses. No diacritic on the adverb *solo* ("sólo") and no accent on demonstratives
  ("éste", "ésta") — both are pre-2010 RAE spelling; write "solo", "este", "esta".
- **Numbers, dates, durations, sizes and costs** never go into a translation by hand: pass them
  through `lib/format` (formatDuration, timeAgo, formatNumber, formatCost…) and interpolate the
  result, so Spanish gets `1.500`, `2 h 5 min`, `hace 5 min`, `1,50 US$`.
- **Never translated**: anything that comes from the CLI, from Claude or from the user (transcripts,
  tool names, file contents, error messages from the API), and literal names: slash commands
  (`/compact`), flags (`--model`), setting keys (including `matcher` and `outputStyle` in
  `settings.json`), permission mode values (`acceptEdits`, `plan`), model names, file and directory
  names (`CLAUDE.md`, `settings.json`, `.claude/workflows/`), environment variables, product names
  (Claude Code, Agentry, claude-swap).

## Kept as in the CLI

An English term stays in English only if a developer in Spain actually says it that way. This list
is much shorter than the previous revision's: `session`, `subagent`, `run`, `output style`,
`permission prompt` and `compact` used to sit here but are not really kept in English (see
"Terms that changed" below) — they were either mistranslated in the files, or entered here by
mistake even though their own rows already gave them a Spanish word.

| Term | In a Spanish sentence |
|---|---|
| worktree | el worktree, los worktrees |
| prompt | el prompt, los prompts |
| system prompt | el system prompt |
| hook | el hook, los hooks |
| MCP, MCP server | el servidor MCP, los servidores MCP |
| skill | la skill, las skills |
| plugin | el plugin, los plugins |
| marketplace | el marketplace |
| token | el token, los tokens |
| slash command | el slash command |
| thinking, extended thinking | el thinking, el extended thinking |
| effort | el effort (the `--effort` level), its values untranslated |
| commit | el commit; "hacer commit", "sin commit" |
| pull request, PR | la pull request, la PR |
| CLI | **el** CLI, never "la CLI": "el CLI no la valida" (`server.json`'s `connectors.authorise.cli`
  currently says "La CLI abre el navegador" — that is the bug this row exists to catch) |
| wrapper | el wrapper — Agentry's own name for its server, the same word CONTRIBUTING.md and
  CLAUDE.md use; no single Spanish word carries it without sounding like a mistranslation |
| worker | el worker, los workers (the runs an orchestration launches; Agentry's own term, kept short) |
| stream | el stream (a run's live event feed): "Stream conectado" |
| preset, tool preset | el preset, los presets (de herramientas) — as assimilated in Spanish
  software as in English, across audio, camera and design tools alike |
| matcher | el matcher (of a hook) — mirrors the literal `matcher` key in `settings.json`; translating
  the UI label while the JSON key stays English would split one concept into two words |
| workflow | el workflow, los workflows — Claude Code's own feature name, tied to the literal
  `.claude/workflows/` directory a user can open in Files; "flujo" was the alternative and was
  rejected because it reads as generic process flow, not this specific saved-script feature |

## The `run` decision

**`run` becomes *ejecución*, not "el run".** The English files themselves already treat the two as
the same concept — `chat.json`'s `side.executions` section header is "Executions" while sibling
strings say "a run" — and the Spanish files already split unevenly down the middle: careful,
structured copy (`schedules.json`'s run history, `orchestrationV2.json`'s template launcher,
`chat.json`'s executions panel) already says "ejecución", while looser, later-written copy
(`components.json`'s notification kinds, `config.json`'s account notes) kept "runs" literally. Since
the more deliberate half of the app already chose the Spanish word, and *ejecución* inflects
cleanly (la ejecución, las ejecuciones, en ejecución, volver a ejecutar) where "el run" forces an
awkward foreign gender onto a word that, unlike `worktree` or `hook`, is not a literal surface the
CLI itself prints — this glossary standardizes on *ejecución*.

This has one ripple effect worth calling out: *ejecución* is feminine, where "el run" was masculine.
`common.json`'s `status.*` object was written on the assumption that its adjectives agree with "el
run" ("fallido", "abortado", "completado"…), while `chat.json`'s `badges.outcome` — which describes
the exact same thing, a chat's execution — was already feminine ("Fallida", "Completada",
"Interrumpida"). Adopting *ejecución* means `common.json`'s table was the one out of step; see
"Terms that changed" for the forms to fix.

## Recurring UI words

Buttons and other actions are infinitive throughout; this replaces the previous revision's
imperative forms wholesale (see "Terms that changed" for the full old → new list).

| English | Spanish |
|---|---|
| Save | Guardar |
| Cancel | Cancelar |
| Delete | Eliminar |
| Remove | Quitar |
| Edit | Editar |
| Close | Cerrar |
| Open | Abrir |
| Add | Añadir |
| Create | Crear |
| New execution | Nueva ejecución |
| New (feminine noun) | Nueva |
| Send | Enviar |
| Send now | Enviar ahora |
| Stop | Detener |
| Resume | Reanudar |
| Retry | Reintentar |
| Refresh | Actualizar |
| Copy / Copied | Copiar / Copiado |
| Search | Buscar (action or trigger), Búsqueda (field / heading) |
| Filter / Sort by | Filtrar / Ordenar por |
| Approve / Deny | Aprobar / Denegar |
| Allow | Permitir |
| Install / Uninstall | Instalar / Desinstalar |
| Enable / Disable | Activar / Desactivar |
| Enabled / Disabled | Activado / Desactivado (a status, stays adjective) |
| Discard | Descartar |
| Reset | Restablecer |
| Apply | Aplicar |
| Confirm | Confirmar |
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
| Re-run (a task) / Relaunch (a graph) | Repetir / Relanzar |
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
| Permission / Permission mode / Permission prompt | Permiso / Modo de permisos / la petición de
  permiso — never "prompt", which is only what a person sends to Claude |
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
| Output style (the `outputStyle`/`--output-style` resource) | Estilo de salida, Estilos de salida
  (the setting key itself stays literal; only the UI label is Spanish, unlike `workflow` — this
  resource has no directory a user browses by that literal name, so nothing forces the English word) |
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
| Schedule (a recurring chat or orchestration) | Programación, las programaciones |
| Cron expression | Expresión cron |
| Slot (the moment a schedule was due) | Franja — not "Hueco": `schedules.json` already says
  "franja" in the overlap hints (`overlaps.parallel/skip/queue`) and "Hueco" only in
  `history.slot`; franja is the one to keep |
| Skipped (a slot missed while the wrapper was down) | Omitida |
| Range (of days) | Rango |
| Export (a transcript) | Exportar |
| Workspace (the wrapper's) | Espacio de trabajo |
| Working directory | Directorio de trabajo |
| Default (value) | Predeterminado — not "por defecto", a calque of "by default" that competes with
  it in half the files (`modelo por defecto`, `Preset por defecto`…); predeterminado is the one to
  keep, see "Terms that changed" |
| Background (a task, a subagent) | segundo plano: "Tareas en segundo plano", tag "segundo plano" |
| Logged in / logged out (Claude Code auth) | sesión iniciada / sesión cerrada (the login, not a
  `session` — see the `session` → `sesión` entry in "Terms that changed") |
| Board (orchestration) | Tablero |
| Details / Output | Detalles / Salida |
| Result | Resultado |
| Tool result / Tool error | Resultado de la herramienta / Error de la herramienta |
| Turn | Turno |
| Decline (a question) | Rechazar |
| Previous | Anterior |
| Clear (a list) | Vaciar |
| Mark all read | Marcar todas como leídas |
| Toast | aviso emergente |
| Live | en directo ("Runs en directo"), never "activo", which translates *active* |
| Theme names | Tema del sistema / Tema claro / Tema oscuro |
| Appearance (the Settings tab) | Apariencia |
| Motion (level): Full / Subtle / Off | Movimiento: Completo / Sutil / Desactivado |
| Tab bar (a phone's bottom navigation) | Pestañas |
| Notification kinds (what to notify about) | a plural noun phrase after "Avísame de": "Ejecuciones
  que me esperan" (was "Runs que me esperan" — see the `run` decision) |

## Status names

Statuses live in `common:status.*` and every badge goes through `statusText()` in
`components/ui.tsx`; a status Agentry does not know is shown as it came. MCP server states
(`connected`, `needs-auth`…) come from the CLI and stay untranslated.

The previous revision made these adjectives agree with "el run" (masculine). Now that `run` is
*ejecución* (feminine), and given most of the nouns a status actually decorates are feminine too —
la ejecución, la tarea, la rama, la programación — the default is feminine. `chat.json`'s
`badges.outcome` already uses these feminine forms; this table now matches it instead of
contradicting it. Where a specific string pins a status to a masculine noun instead (an
"el chat"-shaped sentence, say), the rewriting task local to that file can override the ending —
this table gives the default, not a hard rule.

| English | Spanish |
|---|---|
| starting | iniciando |
| busy | trabajando |
| running | en curso |
| pending | pendiente |
| success | correcto |
| killed | abortada |
| stopped | detenida |
| skipped | omitida |
| merging / merged | fusionando / fusionada |
| resolving | resolviendo |
| conflicted | en conflicto |
| unknown | desconocida |
| queued | en cola |
| waiting | esperando |
| completed | completada |
| failed | fallida |
| cancelled | cancelada |
| interrupted | interrumpida |
| idle | inactivo (agrees with "el chat", the most common subject of this one) |
| live | en directo |
| active | activo |
| error | error |
| blocked | bloqueada |

## The chat model

Terms of the chats redesign. Like the CLI's, most stay in English.

| English | Spanish |
|---|---|
| chat | el chat, los chats: "Nuevo chat", "Chats en curso" |
| execution (of a chat), run | la ejecución, las ejecuciones — the same word for both; see the `run`
  decision above |
| fork (a chat) | el fork; "Crear un fork" |
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
| Skip (give up) a branch | Descartar la rama |
| Purge (the state Claude Code keeps) | Purgar |
| Rename | Renombrar |
| adopted (chats) | adoptados |
| blocked | *bloqueada* for a task (feminine), `bloqueado` in the generic status badge |

## Terms that changed

Every term whose treatment changed in this revision, old form next to the new one, for the
rewriting tasks to search for. An entry with no literal Spanish text (like the categorisation fixes)
is a bookkeeping change only: nothing to search for, but a rule to stop copying.

**Actions: imperative → infinitive** (the change with the widest reach — it touches almost every
file):

| Old (imperative) | New (infinitive) |
|---|---|
| Guarda | Guardar |
| Cancela | Cancelar |
| Elimina | Eliminar |
| Quita | Quitar |
| Edita | Editar |
| Cierra | Cerrar |
| Abre | Abrir |
| Añade | Añadir |
| Crea | Crear |
| Envía | Enviar |
| Detén | Detener |
| Reanuda | Reanudar |
| Reintenta | Reintentar |
| Actualiza | Actualizar |
| Copia | Copiar |
| Busca | Buscar |
| Filtra | Filtrar |
| Aprueba | Aprobar |
| Deniega | Denegar |
| Permite | Permitir |
| Instala | Instalar |
| Desinstala | Desinstalar |
| Activa | Activar |
| Desactiva | Desactivar |
| Descarta | Descartar |
| Restablece | Restablecer |
| Aplica | Aplicar |
| Confirma | Confirmar |
| Rota | Rotar |
| Ejecuta (a button: "Ejecuta un workflow", "Ejecuta ahora") | Ejecutar |
| Lanza | Lanzar |
| Repite | Repetir |
| Relanza | Relanzar |
| Sube (a branch) | Subir |
| Vacía | Vaciar |
| Márcalas todas como leídas | Marcar todas como leídas |
| Rechaza | Rechazar |
| Renombra | Renombrar |
| Sigue (planificando/editando) | Seguir |
| Responde | Responder |
| Registra | Registrar |
| Genera | Generar |
| Decide | Decidir |
| Aumenta / Reduce (stepper buttons) | Aumentar / Reducir |
| Purga | Purgar |
| Exporta Markdown / Exporta JSON | Exportar Markdown / Exportar JSON |
| Sigue planificando | Seguir planificando |
| Vuelve a planificar | Volver a planificar |

**Vocabulary that is no longer kept in English:**

| Old | New |
|---|---|
| la session, las sessions ("Reanuda la session") | la sesión, las sesiones ("Reanudar la sesión") |
| el subagent, los subagents | el subagente, los subagentes |
| el run, los runs | la ejecución, las ejecuciones (see the `run` decision) |
| Nuevo run | Nueva ejecución |
| Hueco (a schedule slot) | Franja |
| Output style / Output styles (the tab and resource-kind labels only; the setting key stays literal) | Estilo de salida / Estilos de salida |
| por defecto ("modelo por defecto", "modo por defecto", "Preset por defecto", "Por defecto") | predeterminado ("modelo predeterminado", "modo predeterminado", "Preset predeterminado", "Predeterminado") |
| "La CLI" (found once, in `server.json`'s `connectors.authorise.cli`) | "El CLI" |
| sólo (the adverb) | solo |

**Categorisation fixes — no text changes needed, just don't read these as "kept in English" anymore:**

- `permission prompt` was listed in the old "Kept as in the CLI" table, but its own value was
  already the Spanish "la petición de permiso". It now lives in "Recurring UI words" instead, where
  its actual treatment belongs.
- `compact` had the same problem: the table entry said "'compactar' is fine as a verb in prose;
  `/compact` stays literal" — a translation rule, not a kept-English word. `/compact` is covered by
  the general literal-slash-command rule; "compactar" needs no dedicated glossary row.

## Related

[[plans/spanish-copy.md]] · [[plans/ui-redesign.md]] · [[status.md]]
