-- Split local image generation config into t2i/i2i (wo -> ltx)
ALTER TABLE `novel_promotion_projects`
  ADD COLUMN `localT2IWidth` INT NOT NULL DEFAULT 1024,
  ADD COLUMN `localT2IHeight` INT NOT NULL DEFAULT 1024,
  ADD COLUMN `localT2ISteps` INT NOT NULL DEFAULT 8,
  ADD COLUMN `localI2IWidth` INT NOT NULL DEFAULT 1024,
  ADD COLUMN `localI2IHeight` INT NOT NULL DEFAULT 1024,
  ADD COLUMN `localI2ISteps` INT NOT NULL DEFAULT 8;

