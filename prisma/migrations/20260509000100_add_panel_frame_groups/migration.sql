-- Add storyboard panel frame groups.
ALTER TABLE `novel_promotion_panels`
  ADD COLUMN `panelMode` VARCHAR(32) NULL DEFAULT 'single',
  ADD COLUMN `groupDurationSec` DOUBLE NULL,
  ADD COLUMN `groupVideoPrompt` TEXT NULL,
  ADD COLUMN `groupPlanJson` TEXT NULL;

CREATE TABLE `novel_promotion_panel_frames` (
  `id` VARCHAR(191) NOT NULL,
  `panelId` VARCHAR(191) NOT NULL,
  `frameIndex` INT NOT NULL,
  `frameTimeSec` DOUBLE NOT NULL,
  `frameRole` TEXT NULL,
  `dependencyFrameIds` TEXT NULL,
  `imagePrompt` TEXT NULL,
  `videoPrompt` TEXT NULL,
  `promptJson` TEXT NULL,
  `referencePolicy` TEXT NULL,
  `imageUrl` TEXT NULL,
  `imageMediaId` VARCHAR(191) NULL,
  `generationStatus` TEXT NULL,
  `errorMessage` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `novel_promotion_panel_frames_panelId_frameIndex_key`
  ON `novel_promotion_panel_frames`(`panelId`, `frameIndex`);

CREATE INDEX `novel_promotion_panel_frames_panelId_idx`
  ON `novel_promotion_panel_frames`(`panelId`);

CREATE INDEX `novel_promotion_panel_frames_imageMediaId_idx`
  ON `novel_promotion_panel_frames`(`imageMediaId`);

ALTER TABLE `novel_promotion_panel_frames`
  ADD CONSTRAINT `novel_promotion_panel_frames_panelId_fkey`
  FOREIGN KEY (`panelId`) REFERENCES `novel_promotion_panels`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `novel_promotion_panel_frames`
  ADD CONSTRAINT `novel_promotion_panel_frames_imageMediaId_fkey`
  FOREIGN KEY (`imageMediaId`) REFERENCES `media_objects`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
