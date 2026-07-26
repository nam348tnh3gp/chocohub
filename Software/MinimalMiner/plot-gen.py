import gc, hashlib, os, struct, sys, time

SCOOP_SIZE = 64
SCOOPS_PER_NONCE = 4096
HEADER_SIZE = 256
PLOT_FORMAT_V2 = 2
ZERO_HASH = '0' * 64

def sha256buf(data):
    return hashlib.sha256(data).digest()

def plot_scoop_count(size_gb):
    return max(1, int((float(size_gb) * 1024 * 1024 * 1024) / SCOOP_SIZE))

def merkle_tree_internal_node_count(n):
    total = 0
    while n > 1:
        n = -(-n // 2)
        total += n
    return total

def plot_total_size(total_scoops, fmt):
    scoop_data_size = total_scoops * SCOOP_SIZE
    if fmt == PLOT_FORMAT_V2:
        return HEADER_SIZE + scoop_data_size + merkle_tree_internal_node_count(total_scoops) * 32
    return HEADER_SIZE + scoop_data_size

def _make_scoop_table():
    return bytes((i * 31 + 7) & 0xFF for i in range(256))

def compute_scoop_data(total_scoops):
    n = total_scoops * SCOOP_SIZE
    table = _make_scoop_table()
    reps = (n + 255) // 256
    return (table * reps)[:n]

def compute_merkle_tree_nodes(leaf_buf, n):
    buf = bytearray(leaf_buf)
    pair_buf = bytearray(64)
    total_internal = merkle_tree_internal_node_count(n)
    result = bytearray(total_internal * 32)
    write_offset = 0
    length = n
    while length > 1:
        new_len = -(-length // 2)
        for i in range(new_len):
            li = i * 2
            ri = min(li + 1, length - 1)
            pair_buf[0:32] = buf[li*32:(li+1)*32]
            pair_buf[32:64] = buf[ri*32:(ri+1)*32]
            h = sha256buf(pair_buf)
            buf[i*32:(i+1)*32] = h
            result[write_offset + i*32:write_offset + (i+1)*32] = h
        write_offset += new_len * 32
        length = new_len
    return result

def create_plot_file(plot_path, plot_id, miner_address, size_gb, progress=True):
    total_scoops = plot_scoop_count(size_gb)
    if total_scoops < 1:
        print('[!] invalid size'); return None

    plot_size = plot_total_size(total_scoops, PLOT_FORMAT_V2)
    file_size_gb = plot_size / (1024**3)

    print(f'  Generating plot: {plot_id}')
    print(f'  Size: {size_gb} GB  scoops: {total_scoops}  file: {file_size_gb:.2f} GB')
    print(f'  Format: V2 (merkle tree)')

    t0 = time.time()

    if progress: print('  [1/4] Generating scoop data...', end='', flush=True)
    scoop_data = compute_scoop_data(total_scoops)
    t1 = time.time()
    if progress: print(f' done ({t1-t0:.1f}s)')

    if progress: print('  [2/4] Computing leaf hashes...', end='', flush=True)
    leaf_buf = bytearray(total_scoops * 32)
    for i in range(total_scoops):
        leaf_buf[i*32:(i+1)*32] = sha256buf(scoop_data[i*SCOOP_SIZE:(i+1)*SCOOP_SIZE])
        if progress and (i % 500000 == 0) and i > 0:
            pct = i * 100 // total_scoops
            print(f' {pct}%', end='', flush=True)
    t2 = time.time()
    if progress: print(f' done ({t2-t1:.1f}s)')

    if progress: print('  [3/4] Building merkle tree...', end='', flush=True)
    tree_nodes = compute_merkle_tree_nodes(leaf_buf, total_scoops)
    root = tree_nodes[-32:].hex() if tree_nodes else ZERO_HASH
    t3 = time.time()
    if progress: print(f' done ({t3-t2:.1f}s)  root={root[:32]}...')

    del leaf_buf
    gc.collect()

    if progress: print('  [4/4] Writing plot file...', end='', flush=True)
    id_high = int(plot_id[:8], 16) if len(plot_id) >= 8 else 0
    id_low  = int(plot_id[8:16], 16) if len(plot_id) >= 16 else 0

    with open(plot_path, 'wb') as f:
        header = bytearray(HEADER_SIZE)
        header[0:8] = b'CHOCOHUB'
        struct.pack_into('<I', header, 8, PLOT_FORMAT_V2)
        struct.pack_into('<I', header, 12, id_high)
        struct.pack_into('<I', header, 16, id_low)
        miner_padded = miner_address.encode('ascii').ljust(44, b'\x00')[:44]
        header[20:64] = miner_padded
        struct.pack_into('<I', header, 64, total_scoops)
        struct.pack_into('<I', header, 68, SCOOP_SIZE)
        header[72:104] = bytes.fromhex(root)
        f.write(header)

        f.write(scoop_data)
        del scoop_data
        gc.collect()

        f.write(tree_nodes)
        del tree_nodes
        gc.collect()

    t4 = time.time()

    written = os.path.getsize(plot_path)
    if progress:
        print(f' done ({t4-t3:.1f}s)')
        print()
        print(f'  Plot created: {plot_path}')
        print(f'  File size:    {written / (1024**3):.3f} GB')
        print(f'  Merkle root:  {root}')
        print(f'  Total time:   {t4-t0:.1f}s')
        print()

    return {'plot_id': plot_id, 'size_gb': size_gb, 'total_scoops': total_scoops, 'merkle_root': root}

def main():
    import argparse
    parser = argparse.ArgumentParser(description='ChocoHub Plot Generator (V2)')
    parser.add_argument('plot_id', help='16-char hex plot ID (e.g. aabbccddee112233)')
    parser.add_argument('size_gb', type=float, help='Plot size in GB (e.g. 0.1, 1, 3)')
    parser.add_argument('--miner', default='0xccd6b34c59f5ac69ea34658017de5f03658c484e59',
                        help='Miner address (0x...)')
    parser.add_argument('--outdir', default='.', help='Output directory')
    parser.add_argument('--quiet', '-q', action='store_true', help='No progress output')
    args = parser.parse_args()

    if len(args.plot_id) < 16 or not all(c in '0123456789abcdefABCDEF' for c in args.plot_id):
        print(f'[!] plot_id must be 16+ hex chars, got: {args.plot_id}')
        sys.exit(1)
    if args.size_gb <= 0:
        print('[!] size_gb must be > 0'); sys.exit(1)

    plot_path = os.path.join(args.outdir, f'{args.plot_id}.plot')
    result = create_plot_file(plot_path, args.plot_id, args.miner, args.size_gb,
                              progress=not args.quiet)
    if result:
        seed_url = os.environ.get('SEED_URL', 'https://seed.chocohub.org')
        try:
            import json, urllib.request, ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            body = json.dumps({
                'miner': args.miner,
                'plot_id': args.plot_id,
                'size_gb': args.size_gb,
                'plot_dir': args.outdir,
            }).encode()
            req = urllib.request.Request(f'{seed_url}/api/poc/create_plot',
                data=body, headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
                resp = json.loads(r.read())
                if resp.get('ok'):
                    print(f'  Registered on {seed_url}')
                else:
                    print(f'  Registration: {resp}')
        except Exception as e:
            print(f'  Registration failed: {e}')
            print(f'  Register manually: python ../cli.js import_plot {args.plot_id} {args.size_gb} {args.miner}')

if __name__ == '__main__':
    main()
