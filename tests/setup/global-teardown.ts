import { loadTestEnv } from './env'
import { runTestComposeDown } from './test-compose'

export async function runGlobalTeardown() {
  loadTestEnv()

  const shouldBootstrap = process.env.BILLING_TEST_BOOTSTRAP === '1' || process.env.SYSTEM_TEST_BOOTSTRAP === '1'
  if (!shouldBootstrap) return
  if (process.env.BILLING_TEST_KEEP_SERVICES === '1') return

  runTestComposeDown()
}
