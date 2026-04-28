-- Add progress popup enabled config
ALTER TABLE `novel_promotion_projects`
  ADD COLUMN `progressPopupEnabled` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `user_preferences`
  ADD COLUMN `progressPopupEnabled` BOOLEAN NOT NULL DEFAULT false;

