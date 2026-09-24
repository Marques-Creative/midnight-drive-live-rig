CREATE TABLE `set_list_songs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`setListId` int NOT NULL,
	`songId` int NOT NULL,
	`position` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `set_list_songs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `set_lists` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `set_lists_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `songs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(255) NOT NULL,
	`artist` varchar(255) DEFAULT 'Midnight Drive',
	`bpm` int,
	`key` varchar(16),
	`duration` int,
	`tags` text,
	`notes` text,
	`lyrics` text,
	`chords` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `songs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`songId` int NOT NULL,
	`name` varchar(128) NOT NULL,
	`fileKey` varchar(512),
	`fileUrl` text,
	`fileSize` int,
	`mimeType` varchar(64),
	`volume` float NOT NULL DEFAULT 1,
	`muted` boolean NOT NULL DEFAULT false,
	`pan` float NOT NULL DEFAULT 0,
	`outputRoute` enum('main','click','guide') NOT NULL DEFAULT 'main',
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `stems_id` PRIMARY KEY(`id`)
);
