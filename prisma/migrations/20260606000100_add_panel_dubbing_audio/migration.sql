-- Add panel-level dubbing audio outputs and persist voice design prompts for project/global characters.

ALTER TABLE `novel_promotion_panels`
  ADD COLUMN `dubbingAudioUrl` TEXT NULL,
  ADD COLUMN `dubbingAudioMediaId` VARCHAR(191) NULL,
  ADD COLUMN `dubbingSourceType` VARCHAR(32) NULL,
  ADD COLUMN `dubbingMetaJson` TEXT NULL;

ALTER TABLE `novel_promotion_characters`
  ADD COLUMN `voicePrompt` TEXT NULL;

ALTER TABLE `global_characters`
  ADD COLUMN `voicePrompt` TEXT NULL;

CREATE INDEX `novel_promotion_panels_dubbingAudioMediaId_idx`
  ON `novel_promotion_panels`(`dubbingAudioMediaId`);

ALTER TABLE `novel_promotion_panels`
  ADD CONSTRAINT `novel_promotion_panels_dubbingAudioMediaId_fkey`
  FOREIGN KEY (`dubbingAudioMediaId`) REFERENCES `media_objects`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
