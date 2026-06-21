import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const uploadMock = vi.fn();
const updateCapture = vi.fn();
let publicUrl = 'https://x.supabase.co/storage/v1/object/public/product-images/p01/1.jpg';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// `withTenant` se mockea para inyectar un `ctx` falso. `ctx.db` lleva el stub
// + un `storage` falso (el handler usa `ctx.db.storage`, no `supabaseAdmin`).
vi.mock('@/lib/tenant', () => ({
  withTenant: (handler: (req: NextRequest, ctx: unknown, params: unknown) => unknown) =>
    (req: NextRequest, params: { companyId: string; id: string }) =>
      handler(
        req,
        {
          db: {
            ...(supabaseStub.client as Record<string, unknown>),
            storage: {
              from: () => ({
                upload: (path: string, _data: unknown, opts: Record<string, unknown>) => {
                  uploadMock(path, opts);
                  return Promise.resolve({ error: null });
                },
                getPublicUrl: (path: string) => ({ data: { publicUrl: publicUrl.replace(/\/[^/]+$/, `/${path.split('/').pop()}`) } }),
              }),
            },
          },
          company: { id: COMPANY_ID, slug: 'bros-and-subs' },
        },
        params,
      ),
}));

import { POST as POST_ROUTE } from './route';

const POST = POST_ROUTE as unknown as (
  req: NextRequest,
  params: { companyId: string; id: string },
) => Promise<Response>;

function params(id: string) {
  return { companyId: 'bros-and-subs', id };
}

function fileRequest(file: File): Request {
  const fd = new FormData();
  fd.append('file', file);
  return new Request('http://localhost:3000/api/bros-and-subs/products/p01/image', {
    method: 'POST',
    body: fd,
  });
}

beforeEach(() => {
  uploadMock.mockReset();
  updateCapture.mockReset();
  publicUrl = 'https://x.supabase.co/storage/v1/object/public/product-images/p01/1.jpg';
  supabaseStub = makeSupabaseStub({
    products: {
      single: { id: 'p01', name: 'Pastrami', price: 28000, cat: 'Sándwiches', sold: 0, available: true, img: '' },
      onUpdate: (payload) => {
        updateCapture(payload);
        return { data: { id: 'p01', name: 'Pastrami', price: 28000, cat: 'Sándwiches', sold: 0, available: true, ...(payload as object) } };
      },
    },
  });
});

describe('POST /api/:companyId/products/:id/image', () => {
  it('sube imagen JPEG con path prefijado por empresa y actualiza products.img', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'foto.jpg', { type: 'image/jpeg' });
    const res = await POST(fileRequest(file) as never, params('p01'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.product.img.endsWith('.jpg')).toBe(true);

    // Upload llamado con path `<companyId>/<id>/<ts>.jpg` + contentType.
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [path, opts] = uploadMock.mock.calls[0];
    expect(path).toMatch(new RegExp(`^${COMPANY_ID}/p01/\\d+\\.jpg$`));
    expect(opts.contentType).toBe('image/jpeg');

    // products.img se actualizó.
    expect(updateCapture).toHaveBeenCalled();
  });

  it('PNG → extensión .png', async () => {
    const file = new File([new Uint8Array([1])], 'foto.png', { type: 'image/png' });
    await POST(fileRequest(file) as never, params('p01'));
    const [path] = uploadMock.mock.calls[0];
    expect(path.endsWith('.png')).toBe(true);
  });

  it('400 si MIME no es imagen', async () => {
    const file = new File([new Uint8Array([1])], 'doc.pdf', { type: 'application/pdf' });
    const res = await POST(fileRequest(file) as never, params('p01'));
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('400 si pesa más de 5 MB', async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    const file = new File([big], 'huge.jpg', { type: 'image/jpeg' });
    const res = await POST(fileRequest(file) as never, params('p01'));
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('400 si falta el campo file', async () => {
    const fd = new FormData();
    const req = new Request('http://localhost:3000/api/bros-and-subs/products/p01/image', { method: 'POST', body: fd });
    const res = await POST(req as never, params('p01'));
    expect(res.status).toBe(400);
  });

  it('404 si producto no existe', async () => {
    supabaseStub = makeSupabaseStub({ products: { single: null } });
    const file = new File([new Uint8Array([1])], 'foto.jpg', { type: 'image/jpeg' });
    const res = await POST(fileRequest(file) as never, params('missing'));
    expect(res.status).toBe(404);
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
