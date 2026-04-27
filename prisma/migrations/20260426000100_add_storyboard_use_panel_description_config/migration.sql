-- Add storyboard prompt source config (wo -> ltx local)
ALTER TABLE `novel_promotion_projects`
  ADD COLUMN `localStoryboardUsePanelDescriptionEnabled` BOOLEAN NOT NULL DEFAULT false;
