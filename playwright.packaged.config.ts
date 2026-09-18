import { defineConfig } from '@playwright/test'
import desktop from './playwright.config'

export default defineConfig({
  ...desktop,
  testIgnore: [],
  testMatch: '**/packaged.spec.ts',
  outputDir: 'test-results/packaged',
})
