import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

export interface StorageOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

export function createStorage(options: StorageOptions): S3Client {
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    forcePathStyle: options.forcePathStyle,
  });
}

/** Create the bucket if it does not exist (MinIO has no auto-create). */
export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch {
    // fall through to create
  }
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
}

export async function uploadStream(
  client: S3Client,
  bucket: string,
  key: string,
  body: Readable,
  contentType = "text/csv",
): Promise<void> {
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
  });
  await upload.done();
}

export async function getObjectStream(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Readable> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Object ${key} has no body`);
  return res.Body as Readable;
}

export async function deleteObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
