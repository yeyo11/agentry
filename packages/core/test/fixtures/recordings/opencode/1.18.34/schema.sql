user_version [ [Object: null prototype] { user_version: 0 } ] journal [ [Object: null prototype] { journal_mode: 'wal' } ]
-- index event_aggregate_seq_idx
CREATE UNIQUE INDEX `event_aggregate_seq_idx` ON `event` (`aggregate_id`,`seq`);
-- index event_aggregate_type_seq_idx
CREATE INDEX `event_aggregate_type_seq_idx` ON `event` (`aggregate_id`,`type`,`seq`);
-- index message_session_time_created_id_idx
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
-- index part_message_id_id_idx
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
-- index part_session_idx
CREATE INDEX `part_session_idx` ON `part` (`session_id`);
-- index permission_project_action_resource_idx
CREATE UNIQUE INDEX `permission_project_action_resource_idx` ON `permission` (`project_id`,`action`,`resource`);
-- index session_input_session_admitted_seq_idx
CREATE UNIQUE INDEX `session_input_session_admitted_seq_idx` ON `session_input` (`session_id`,`admitted_seq`);
-- index session_input_session_pending_delivery_seq_idx
CREATE INDEX `session_input_session_pending_delivery_seq_idx` ON `session_input` (`session_id`,`promoted_seq`,`delivery`,`admitted_seq`);
-- index session_input_session_promoted_seq_idx
CREATE UNIQUE INDEX `session_input_session_promoted_seq_idx` ON `session_input` (`session_id`,`promoted_seq`);
-- index session_message_session_seq_idx
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
-- index session_message_session_time_created_id_idx
CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`);
-- index session_message_session_type_seq_idx
CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`,`type`,`seq`);
-- index session_message_time_created_idx
CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);
-- index session_parent_idx
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);
-- index session_project_idx
CREATE INDEX `session_project_idx` ON `session` (`project_id`);
-- index session_workspace_idx
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);
-- index todo_session_idx
CREATE INDEX `todo_session_idx` ON `todo` (`session_id`);
-- table account
CREATE TABLE `account` (
          `id` text PRIMARY KEY,
          `email` text NOT NULL,
          `url` text NOT NULL,
          `access_token` text NOT NULL,
          `refresh_token` text NOT NULL,
          `token_expiry` integer,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
-- table account_state
CREATE TABLE `account_state` (
          `id` integer PRIMARY KEY,
          `active_account_id` text,
          `active_org_id` text,
          CONSTRAINT `fk_account_state_active_account_id_account_id_fk` FOREIGN KEY (`active_account_id`) REFERENCES `account`(`id`) ON DELETE SET NULL
        );
-- table control_account
CREATE TABLE `control_account` (
          `email` text NOT NULL,
          `url` text NOT NULL,
          `access_token` text NOT NULL,
          `refresh_token` text NOT NULL,
          `token_expiry` integer,
          `active` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `control_account_pk` PRIMARY KEY(`email`, `url`)
        );
-- table credential
CREATE TABLE `credential` (
          `id` text PRIMARY KEY,
          `integration_id` text,
          `label` text NOT NULL,
          `value` text NOT NULL,
          `connector_id` text,
          `method_id` text,
          `active` integer,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
-- table data_migration
CREATE TABLE `data_migration` (
          `name` text PRIMARY KEY,
          `time_completed` integer NOT NULL
        );
-- table event
CREATE TABLE `event` (
          `id` text PRIMARY KEY,
          `aggregate_id` text NOT NULL,
          `seq` integer NOT NULL,
          `type` text NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_event_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
        );
-- table event_sequence
CREATE TABLE `event_sequence` (
          `aggregate_id` text PRIMARY KEY,
          `seq` integer NOT NULL,
          `owner_id` text
        );
-- table message
CREATE TABLE `message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
-- table migration
CREATE TABLE "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
-- table part
CREATE TABLE `part` (
          `id` text PRIMARY KEY,
          `message_id` text NOT NULL,
          `session_id` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
        );
-- table permission
CREATE TABLE `permission` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `action` text NOT NULL,
          `resource` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `fk_permission_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
-- table project
CREATE TABLE `project` (
          `id` text PRIMARY KEY,
          `worktree` text NOT NULL,
          `vcs` text,
          `name` text,
          `icon_url` text,
          `icon_url_override` text,
          `icon_color` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_initialized` integer,
          `sandboxes` text NOT NULL,
          `commands` text
        );
-- table project_directory
CREATE TABLE `project_directory` (
          `project_id` text NOT NULL,
          `directory` text NOT NULL,
          `type` text,
          `strategy` text,
          `time_created` integer NOT NULL,
          CONSTRAINT `project_directory_pk` PRIMARY KEY(`project_id`, `directory`),
          CONSTRAINT `fk_project_directory_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
-- table session
CREATE TABLE `session` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text NOT NULL,
          `version` text NOT NULL,
          `share_url` text,
          `summary_additions` integer,
          `summary_deletions` integer,
          `summary_files` integer,
          `summary_diffs` text,
          `metadata` text,
          `cost` real DEFAULT 0 NOT NULL,
          `tokens_input` integer DEFAULT 0 NOT NULL,
          `tokens_output` integer DEFAULT 0 NOT NULL,
          `tokens_reasoning` integer DEFAULT 0 NOT NULL,
          `tokens_cache_read` integer DEFAULT 0 NOT NULL,
          `tokens_cache_write` integer DEFAULT 0 NOT NULL,
          `revert` text,
          `permission` text,
          `agent` text,
          `model` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_compacting` integer,
          `time_archived` integer,
          CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
-- table session_context_epoch
CREATE TABLE `session_context_epoch` (
          `session_id` text PRIMARY KEY,
          `baseline` text NOT NULL,
          `snapshot` text NOT NULL,
          `baseline_seq` integer NOT NULL,
          CONSTRAINT `fk_session_context_epoch_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
-- table session_input
CREATE TABLE `session_input` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `prompt` text NOT NULL,
          `delivery` text NOT NULL,
          `admitted_seq` integer NOT NULL,
          `promoted_seq` integer,
          `time_created` integer NOT NULL,
          CONSTRAINT `fk_session_input_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
-- table session_message
CREATE TABLE `session_message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
-- table session_share
CREATE TABLE `session_share` (
          `session_id` text PRIMARY KEY,
          `id` text NOT NULL,
          `secret` text NOT NULL,
          `url` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `fk_session_share_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
-- table todo
CREATE TABLE `todo` (
          `session_id` text NOT NULL,
          `content` text NOT NULL,
          `status` text NOT NULL,
          `priority` text NOT NULL,
          `position` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `todo_pk` PRIMARY KEY(`session_id`, `position`),
          CONSTRAINT `fk_todo_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
-- table workspace
CREATE TABLE `workspace` (
          `id` text PRIMARY KEY,
          `type` text NOT NULL,
          `name` text DEFAULT '' NOT NULL,
          `branch` text,
          `directory` text,
          `extra` text,
          `project_id` text NOT NULL,
          `time_used` integer NOT NULL,
          CONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
data_migration []
migration [{"id":"20260127222353_familiar_lady_ursula","time_completed":1790851760792},{"id":"20260211171708_add_project_commands","time_completed":1790851760792},{"id":"20260213144116_wakeful_the_professor","time_completed":1790851760792},{"id":"20260225215848_workspace","time_completed":1790851760792},{"id":"20260227213759_add_session_workspace_id","time_completed":1790851760792},{"id":"20260228203230_blue_harpoon","time_completed":1790851760792},{"id":"20260303231226_add_workspace_fields","time_completed":1790851760793},{"id":"20260309230000_move_org_to_state","time_completed":1790851760793},{"id":"20260312043431_session_message_cursor","time_completed":1790851760793},{"id":"20260323234822_events","time_completed":1790851760793},{"id":"20260410174513_workspace-name","time_completed":1790851760793},{"id":"20260413175956_chief_energizer","time_completed":1790851760793},{"id":"20260423070820_add_icon_url_override","time_completed":1790851760793},{"id":"20260427172553_slow_nightmare","time_completed":1790851760793},{"id":"20260428004200_add_session_path","time_completed":1790851760793},{"id":"20260501142318_next_venus","time_completed":1790851760793},{"id":"20260504145000_add_sync_owner","time_completed":1790851760793},{"id":"20260507164347_add_workspace_time","time_completed":1790851760794},{"id":"20260510033149_session_usage","time_completed":1790851760794},{"id":"20260511000411_data_migration_state","time_completed":1790851760794},{"id":"20260511173437_session-metadata","time_completed":1790851760794},{"id":"20260601010001_normalize_storage_paths","time_completed":1790851760794},{"id":"20260601202201_amazing_prowler","time_completed":1790851760794},{"id":"20260602002951_lowly_union_jack","time_completed":1790851760795},{"id":"20260602182828_add_project_directories","time_completed":1790851760795},{"id":"20260603001617_session_message_projection_indexes","time_completed":1790851760795},{"id":"20260603040000_session_message_projection_order","time_completed":1790851760795},{"id":"20260603141458_session_input_inbox","time_completed":1790851760795},{"id":"20260603160727_jittery_ezekiel_stane","time_completed":1790851760795},{"id":"20260604172448_event_sourced_session_input","time_completed":1790851760795},{"id":"20260605003541_add_session_context_snapshot","time_completed":1790851760795},{"id":"20260605042240_add_context_epoch_agent","time_completed":1790851760795},{"id":"20260611035744_credential","time_completed":1790851760795},{"id":"20260611192811_lush_chimera","time_completed":1790851760796},{"id":"20260612174303_project_dir_strategy","time_completed":1790851760796},{"id":"20260622142730_simplify_session_context_epoch","time_completed":1790851760796},{"id":"20260622170816_reset_v2_session_state","time_completed":1790851760796},{"id":"20260622202450_simplify_session_input","time_completed":1790851760796}]
