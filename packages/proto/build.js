const { execSync } = require('child_process');

const path = require('path');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const pluginPath = path.join(__dirname, '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'protoc-gen-ts_proto.cmd' : 'protoc-gen-ts_proto');
const cmd = `${npx} grpc_tools_node_protoc --plugin=protoc-gen-ts_proto="${pluginPath}" --ts_proto_out=. --ts_proto_opt=outputServices=grpc-js,env=node,esModuleInterop=true -I=. dice.proto dnd.proto`;

try {
    console.log('Running:', cmd);
    execSync(cmd, { stdio: 'inherit', shell: true });
    console.log('Protobuf compilation successful');
} catch (err) {
    console.error('Failed to compile protobufs', err.message);
    process.exit(1);
}
