-- Add project-level local video LoRA config for wo -> ltx integration.
ALTER TABLE `novel_promotion_projects`
  ADD COLUMN `localVideoLoras` TEXT NULL;
