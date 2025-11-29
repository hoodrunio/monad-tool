#!/usr/bin/env python3
"""
Test script to fetch peer information from Monad Control Panel IPC socket.
Usage: python3 test_ipc.py [socket_path]
"""

import socket
import struct
import json
import sys

def send_length_delimited(sock, data):
    """Send data with length prefix (LengthDelimitedCodec format)"""
    length = len(data)
    # Send 4-byte length prefix (big-endian)
    sock.sendall(struct.pack('>I', length))
    # Send the actual data
    sock.sendall(data)

def recv_length_delimited(sock):
    """Receive length-delimited data"""
    # Read 4-byte length prefix
    length_bytes = sock.recv(4)
    if len(length_bytes) < 4:
        return None
    length = struct.unpack('>I', length_bytes)[0]

    # Read the actual data
    data = b''
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            break
        data += chunk

    return data

def main():
    # Socket path from command line or default
    socket_path = sys.argv[1] if len(sys.argv) > 1 else "/home/monad/monad-bft/controlpanel.sock"

    print(f"Connecting to {socket_path}...")

    # Create Unix socket
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

    try:
        sock.connect(socket_path)
        print("Connected!\n")

        # Prepare GetPeers request
        request = {"Read": {"GetPeers": "Request"}}
        request_json = json.dumps(request)
        request_bytes = request_json.encode('utf-8')

        print(f"Sending request: {request_json}")
        send_length_delimited(sock, request_bytes)

        # Receive response
        print("Waiting for response...\n")
        response_bytes = recv_length_delimited(sock)

        if response_bytes:
            response_str = response_bytes.decode('utf-8')
            print(f"Raw response:\n{response_str}\n")

            # Parse JSON
            response = json.loads(response_str)
            print("Parsed response:")
            print(json.dumps(response, indent=2))

            # Extract peer info if present
            if "Read" in response:
                read_data = response["Read"]
                if "GetPeers" in read_data:
                    peers_data = read_data["GetPeers"]
                    if "Response" in peers_data:
                        peers = peers_data["Response"]
                        print(f"\n{'='*60}")
                        print(f"Total peers: {len(peers)}")
                        print(f"{'='*60}\n")

                        for i, peer in enumerate(peers, 1):
                            print(f"Peer {i}:")
                            print(f"  Address: {peer.get('addr', 'N/A')}")
                            print(f"  PubKey: {peer.get('pubkey', 'N/A')}")
                            print(f"  Seq Num: {peer.get('record_seq_num', 'N/A')}")
                            print(f"  Signature: {peer.get('signature', 'N/A')[:50]}..." if 'signature' in peer else "  Signature: N/A")
                            print()
        else:
            print("No response received")

    except FileNotFoundError:
        print(f"Error: Socket not found at {socket_path}")
        print("Make sure the Monad node is running and the path is correct.")
        sys.exit(1)
    except ConnectionRefusedError:
        print(f"Error: Connection refused to {socket_path}")
        print("Make sure the Monad node is running.")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        sock.close()

if __name__ == "__main__":
    main()
