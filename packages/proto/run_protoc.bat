@echo off
set PLUGIN_PATH=c:\Users\synt_\dev\wow\node_modules\.bin\protoc-gen-ts_proto.cmd
set PROTOC_CMD=c:\Users\synt_\dev\wow\node_modules\.bin\grpc_tools_node_protoc.cmd

%PROTOC_CMD% --plugin=protoc-gen-ts_proto="%PLUGIN_PATH%" --ts_proto_out=. --ts_proto_opt=outputServices=grpc-js,env=node,esModuleInterop=true -I=. dice.proto dnd.proto
