import {ccc, ClientPublicTestnet, hashTypeId, Script, Signer, SignerCkbPrivateKey, Transaction} from "@ckb-ccc/core"
import { blockchain } from "@ckb-lumos/base";
import { molecule, number } from "@ckb-lumos/codec";

import fs from "fs";
import { adler32 } from "hash-wasm";


const ckbfsDataHash = "0x31e6376287d223b8c0410d562fb422f04d1d617b2947596a14c3d2efb7218d3a";
const ckbfsCellDepsTx = "0x469af0d961dcaaedd872968a9388b546717a6ccfa47b3165b3f9c981e9d66aaa";

const Indexes = molecule.vector(number.Uint32);
const textEncoder = new TextEncoder();

const BackLink = molecule.table(
    {
      index: Indexes,
      checksum: number.Uint32,
      txHash: blockchain.Byte32,
    },
    ["index", "checksum", "txHash"]
  );
const BackLinks = molecule.vector(BackLink);
const CKBFSData = molecule.table(
  {
    index: Indexes,
    checksum: number.Uint32,
    contentType: blockchain.Bytes,
    filename: blockchain.Bytes,
    backLinks: BackLinks,
  },
  ["index", "checksum", "contentType", "filename", "backLinks"]
);

function hexToBytes(hex: number): Uint8Array {
    let hexString = hex.toString(16);
    const bytes = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
        bytes[i / 2] = parseInt(hexString.substr(i, 2), 16);
    }
    return bytes;
}

function uint8ArrayToHex(uint8Array: Uint8Array): string {
    return Array.from(uint8Array)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

async function main() {
    console.log(uint8ArrayToHex(Indexes.pack([0x1])));
    // Read file contents and generate Adler-32 checksum
    const filePath = "./kazeno_matasaburou.txt";
    const fileContents = fs.readFileSync(filePath, "utf-8");
    const fileBuffer = textEncoder.encode(fileContents);
    const checksumString = await adler32(textEncoder.encode(fileContents));
    const checksumBuffer = Buffer.from(checksumString, 'hex');
    const checksum = checksumBuffer.readUInt32BE();
    // print checksum to ensure hand-debug stuffs
    console.log(`checksum:${checksum}`);
    const chunkSize = 30 * 1024;
    const fileChunks: Buffer[] = [];
    // split file chunks. in order to avoid lock script limitation
    for (let i = 0; i < fileBuffer.length; i += chunkSize) {
        fileChunks.push(Buffer.from(fileBuffer.slice(i, i + chunkSize)));
    }


    const outputData = CKBFSData.pack({
        index: Array.from({ length: fileChunks.length}, (_, i) => 0x1 + i),
        checksum: checksum,
        contentType: textEncoder.encode("plain/text"),
        filename: textEncoder.encode("kazeno_matasaburou.txt"),
        backLinks: [],
    });

    // Create CKBFS witnesses vector by chunk(splitted witnesses)
    const ckbfsWitnesses = fileChunks.map((chunk, _) => {
        return Buffer.concat([
            textEncoder.encode("CKBFS"),
            new Uint8Array([0x0]),
            chunk
        ]).toString("hex");
    });

    const client = new ClientPublicTestnet();

    const privateKey = process.env.CKB_PRIVATE_KEY;
        if (!privateKey) {
            throw new Error("CKB_PRIVATE_KEY is not set in the environment variables");
        }
    const signer = new SignerCkbPrivateKey(client, privateKey);

    const address = await signer.getRecommendedAddressObj();
    console.log(`address:${address}`);
    const lock = address.script;

    const pre_ckbfs_type_script = new Script(ckbfsDataHash, "data1", "0x0000000000000000000000000000000000000000000000000000000000000000");

    const preTx = Transaction.from(
        {
            cellDeps: [
                {
                    outPoint: {
                        txHash: ckbfsCellDepsTx,
                        index: 0x0,
                    },
                    depType: "depGroup"
                }
            ],

            outputs: [
                {
                    lock,
                    type: pre_ckbfs_type_script,
                }
            ],

            witnesses: [
                [],
                ...ckbfsWitnesses.map((chunk,_) =>{return `0x${chunk}`}).slice(),
            ],
            outputsData: [
                outputData,
            ]
        }
    )
    await preTx.completeInputsByCapacity(signer);
    await preTx.completeFeeChangeToLock(signer, lock, 2000);
    let args = ccc.hashTypeId(preTx.inputs[0], 0x0);
    const ckbfs_type_script = new Script(ckbfsDataHash, "data1", args);
    const tx = Transaction.from({
        cellDeps: preTx.cellDeps,
        witnesses: [[], ...ckbfsWitnesses.map((chunk,_) =>{return `0x${chunk}`}).slice(),],
        outputsData: preTx.outputsData,
        inputs: preTx.inputs,
        outputs: [
            {
                lock,
                type: ckbfs_type_script,
                capacity: preTx.outputs[0].capacity,
            },
            ...preTx.outputs.slice(1)
        ]
    })
    const signedTx = await signer.signTransaction(tx);

    // maybe don't print this? too long logs.
    //console.log(signedTx.stringify());

    const txHash = await client.sendTransaction(signedTx);

    console.log(`${txHash}`);

}

main().then(() => {
    console.log("completed successfully.");
    process.exit(0);
}).catch((error) => {
    console.error("Unexpected error occurred:", error);
    process.exit(-1);
});
