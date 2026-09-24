ALTER TABLE `songs` ADD `audioFileKey` varchar(512);--> statement-breakpoint
ALTER TABLE `songs` ADD `audioFileUrl` text;--> statement-breakpoint
ALTER TABLE `songs` ADD `audioFileSize` int;--> statement-breakpoint
ALTER TABLE `songs` ADD `audioMimeType` varchar(64);