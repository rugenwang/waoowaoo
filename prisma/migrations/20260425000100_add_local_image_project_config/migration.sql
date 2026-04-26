-- Add local image generation config fields for wo -> ltx integration
ALTER TABLE `novel_promotion_projects`
  ADD COLUMN `localImageWidth` INT NOT NULL DEFAULT 1024,
  ADD COLUMN `localImageHeight` INT NOT NULL DEFAULT 1024,
  ADD COLUMN `localImageSteps` INT NOT NULL DEFAULT 8;

