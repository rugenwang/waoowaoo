CREATE TABLE `agent_creation_runs` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `sourceHash` VARCHAR(71) NOT NULL,
  `runFingerprint` VARCHAR(71) NOT NULL,
  `inputKindHint` VARCHAR(16) NOT NULL,
  `locale` VARCHAR(8) NOT NULL,
  `effectiveOptionsJson` TEXT NOT NULL,
  `ruleSetVersion` VARCHAR(64) NOT NULL,
  `ruleSetHash` VARCHAR(71) NOT NULL,
  `definitionHash` VARCHAR(71) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'created',
  `currentStage` VARCHAR(64) NOT NULL DEFAULT 'created',
  `episodeMapJson` LONGTEXT NOT NULL,
  `assetMapJson` LONGTEXT NULL,
  `clipMapJson` LONGTEXT NULL,
  `storyboardMapJson` LONGTEXT NULL,
  `artifactHashesJson` LONGTEXT NULL,
  `receiptJson` LONGTEXT NULL,
  `lastErrorJson` LONGTEXT NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `agent_creation_runs_userId_projectId_runFingerprint_key`
  ON `agent_creation_runs`(`userId`, `projectId`, `runFingerprint`);

CREATE INDEX `agent_creation_runs_projectId_status_idx`
  ON `agent_creation_runs`(`projectId`, `status`);

CREATE INDEX `agent_creation_runs_userId_createdAt_idx`
  ON `agent_creation_runs`(`userId`, `createdAt`);

ALTER TABLE `agent_creation_runs`
  ADD CONSTRAINT `agent_creation_runs_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `agent_creation_runs`
  ADD CONSTRAINT `agent_creation_runs_projectId_fkey`
  FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
