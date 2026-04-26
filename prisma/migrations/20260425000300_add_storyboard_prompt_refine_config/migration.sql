-- Add storyboard prompt refine config (wo -> ltx local)
ALTER TABLE `novel_promotion_projects`
  ADD COLUMN `localStoryboardPromptRefineEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `localStoryboardPromptRefineLevel` VARCHAR(191) NOT NULL DEFAULT 'medium';

