import { describe, expect, it } from 'vitest'
import { agentCatalogSync } from './agent-catalog-sync'
import { agentReferenceSync } from './agent-reference-sync'
import type { RpcClient } from './rpc-client'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeClient(response: unknown): { client: RpcClient; methods: string[] } {
  const methods: string[] = []
  const client = {
    sendRequest: async (method: string) => {
      methods.push(method)
      return response
    },
    getState: () => 'connected'
  } as unknown as RpcClient
  return { client, methods }
}

describe('agentCatalogSync', () => {
  it('hydrates the catalog snapshot from settings.get', async () => {
    const { client, methods } = fakeClient({
      ok: true,
      id: '1',
      result: {
        agentCatalog: {
          version: 1,
          revision: 7,
          defaultAgent: 'auto',
          disabledAgents: [],
          customAgents: [],
          deletedCustomAgents: []
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const conn = agentCatalogSync.openConnection('cat-a', client)
    conn.hydrate()
    await tick()

    expect(methods).toEqual(['settings.get'])
    expect(agentCatalogSync.getSnapshot('cat-a')).toMatchObject({ version: 1, revision: 7 })

    conn.dispose()
    agentCatalogSync.clear('cat-a')
  })

  it('stores the projection error variant so repair copy can render', async () => {
    const { client } = fakeClient({
      ok: true,
      id: '1',
      result: {
        agentCatalog: {
          version: 1,
          revision: 4,
          code: 'agent_catalog_payload_too_large',
          maxBytes: 524_288
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const conn = agentCatalogSync.openConnection('cat-b', client)
    conn.hydrate()
    await tick()

    expect(agentCatalogSync.getSnapshot('cat-b')).toMatchObject({
      version: 1,
      code: 'agent_catalog_payload_too_large'
    })

    conn.dispose()
    agentCatalogSync.clear('cat-b')
  })

  it('ignores a response missing the agentCatalog field', async () => {
    const { client } = fakeClient({ ok: true, id: '1', result: {}, _meta: { runtimeId: 'r' } })
    const conn = agentCatalogSync.openConnection('cat-c', client)
    conn.hydrate()
    await tick()
    expect(agentCatalogSync.getSnapshot('cat-c')).toBeNull()
    conn.dispose()
    agentCatalogSync.clear('cat-c')
  })
})

describe('agentReferenceSync', () => {
  it('hydrates the reference snapshot from settings.agentReferences.get', async () => {
    const { client, methods } = fakeClient({
      ok: true,
      id: '1',
      result: {
        agentReferences: {
          version: 1,
          revision: 3,
          terminalQuickCommands: []
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const conn = agentReferenceSync.openConnection('ref-a', client)
    conn.hydrate()
    await tick()

    expect(methods).toEqual(['settings.agentReferences.get'])
    expect(agentReferenceSync.getSnapshot('ref-a')).toMatchObject({ version: 1, revision: 3 })

    conn.dispose()
    agentReferenceSync.clear('ref-a')
  })
})
