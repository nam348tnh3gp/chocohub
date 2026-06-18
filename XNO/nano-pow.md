nano-pow

Proof-of-work generation and validation with WebGPU/WebGL for Nano cryptocurrency.

NanoPow uses WebGPU to generate proof-of-work nonces meeting the requirements of the Nano cryptocurrency. WebGPU is cutting edge technology, so for browsers which do not yet support it, WebGL 2.0 and WASM implementations are available as fallbacks.

All calculations take place client-side, so nonces can be generated offline and cached for the next transaction block. For more information about the proof-of-work equation defined by Nano, see https://docs.nano.org/integration-guides/work-generation/#work-calculation-details

NanoPow can also be installed globally to add the nano-pow command to the system environment. To learn more, see #Executables.

The easiest way to use NanoPow is to import it directly. Based on the features available in the environment, NanoPow will try to use its most performant API.

The following two import statements are equivalent, and both are provided to accomodate project style preferences:

import { NanoPow } from "nano-pow";
// OR
import NanoPow from "nano-pow";
Use it directly on a webpage with a script module:

<script type="module">
  (async () => {
    const { NanoPow } =
      await import("https://cdn.jsdelivr.net/npm/nano-pow@latest");
    const { work } = await NanoPow.work_generate(some_hash);
    console.log(work);
  })();
</script>
// `hash` is a 64-char hex string
const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const result = await NanoPow.work_generate(hash);
const { hash, work, difficulty } = result;
console.log(work);
// Result is a 16-char hex string
// `work` is a 16-char hex string
const work = "fedcba0987654321";
// `hash` is a 64-char hex string
const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const result = await NanoPow.work_validate(work, hash);
const { hash, work, difficulty, valid_all, valid_receive, valid } = result;
console.log(valid);
// Result is string '0' or '1'
const options = {
  // default best available in order: webgpu => webgl => wasm => cpu
  api: "webgpu",
  // default FFFFFFF800000000 for send/change blocks
  difficulty: "FFFFFFC000000000",
  // default 4, valid range 1-32
  effort: 2,
  // default false
  debug: true,
};
const { work } = await NanoPow.work_generate(hash, options);
NanoPow's "effort" metric is an abstraction of various GPU and CPU capabilities. Different systems will have different optimal settings, but as a general rule of thumb:

WebGPU must strike a balance between the overhead of dispatching work to the GPU and the time it takes to compute the dispatch itself. Start with a low value like 2 or 4.
WegGL works by drawing to an invisible 2-D canvas that is effort * 256 pixels long on each side. Since PoW speed in this case depends on resolution and framerate, push for a value as high as the GPU can support. For example, a GPU that can draw 4096 x 4096 at 15 FPS should be set around 16 effort.
WASM does not use the GPU at all and instead depends on Web Workers for CPU multi-threading capabilities. Set effort equal to the number of physical cores in the CPU.
NanoPow can be installed globally and executed from the command line. This is useful for systems without a graphical interface.

npm -g i nano-pow
nano-pow --help    # view abbreviated CLI help
man nano-pow       # view full manual
Ensure proper permissions exist on the npm prefix directory and that PATH is also configured accordingly. nvm is a great tool that handles this automatically.

NanoPow provides a shell command—nano-pow—to accomodate systems without a graphical user interface. It launches a headless Chrome browser using puppeteer to access the required WebGPU or WebGL APIs. Use the --global flag when installing to add the executable script to the system.

Some examples are provided below, and for full documentation, read the manual with man nano-pow.

# Generate a work value using default settings and debugging output enabled.
nano-pow --debug 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
# Generate work using customized behavior with options.
nano-pow --effort 32 --difficulty FFFFFFC000000000 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
# Validate an existing work nonce against a blockhash.
nano-pow --validate fedcba9876543210 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
# Process blockhashes in batches to reduce the initial startup overhead.
nano-pow 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef [...]
# OR
nano-pow $(cat /path/to/hashes/file)
# OR
cat /path/to/hashes/file | nano-pow
NanoPow also provides a basic work server similar to the one included in the official Nano node software. The installed command will launch the server in a detached process, and it can also be started manually to customize behavior by executing the server script directly.

NANO_POW_DEBUG: enable additional logging saved to the HOME directory

NANO_POW_EFFORT: increase or decrease demand on the GPU

NANO_POW_PORT: override the default port 5040

# Launch the server and detach from the current session
NANO_POW_PORT=8080 nano-pow --server
# View process ID for "NanoPow Server"
cat ~/.nano-pow/server.pid
# Display list of server logs
ls ~/.nano-pow/logs/
# Find process ID manually
pgrep NanoPow
Work is generated or validated by sending an HTTP POST request to the configured hostname or IP address of the machine. Some basic help is available via GET request.

$ # Generate a work value
$ curl -d '{
  "action": "work_generate",
  "hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}' localhost:5040
$ # Validate a work value
$ curl -d '{
  "action": "work_validate",
  "work": "e45835c3b291c3d1",
  "hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}' localhost:5040
The work field in a Nano transaction block contains an 8-byte nonce that satisfies the following equation:

𝘣𝘭𝘢𝘬𝘦2𝘣(𝘯𝘰𝘯𝘤𝘦 || 𝘣𝘭𝘰𝘤𝘬𝘩𝘢𝘴𝘩) ≥ 𝘵𝘩𝘳𝘦𝘴𝘩𝘰𝘭𝘥

𝘣𝘭𝘢𝘬𝘦2𝘣() is the cryptographic hash function BLAKE2b.
𝘯𝘰𝘯𝘤𝘦, an 8-byte value, is generated for the transaction.
|| is concatenation.
𝘣𝘭𝘰𝘤𝘬𝘩𝘢𝘴𝘩, a 32-byte value, is either the public key of brand new accounts without transactions or the hash of the most recent block in the account chain for all other accounts.
𝘵𝘩𝘳𝘦𝘴𝘩𝘰𝘭𝘥 is 0xFFFFFFF800000000 for send/change blocks and 0xFFFFFE0000000000 for receive/open/epoch blocks.
The BLAKE2b implementation has been optimized to the extreme for this package due to the very narrow use case to which it is applied. The compute shader used by the WebGPU implementation is consequently immense, but the goal is to squeeze every last bit of speed and performance out of it.

A few basic tests are available in the source repository.

test/index.html in the source repository contains a web interface to change execution options and compare results.
test/script.sh runs some basic benchmarks to check the CLI, and then it starts the nano-pow server and sends some validate and generate requests.
Clone source
Enter the directory
Install dev dependencies
Compile, minify, and bundle
git clone https://codecow.com/nano-pow.git
cd nano-pow
npm i
Email: bug-nano-pow@codecow.com

numtel/nano-webgl-pow for his original WebGL implementation.

GNU GPL version 3 or later https://gnu.org/licenses/gpl.html Portions of this code are also provided under the MIT License: https://spdx.org/licenses/MIT.html

Tips are always appreciated and can be sent to the following developer address:

nano_1zosoqs47yt47bnfg7sdf46kj7asn58b7uzm9ek95jw7ccatq37898u1zoso
