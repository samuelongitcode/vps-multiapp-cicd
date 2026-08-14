# Minimal file upload/list service - demonstrates an app using the SHARED
# MinIO instance, isolated purely by bucket name/credentials.
import os
from flask import Flask, request, jsonify
from minio import Minio

app = Flask(__name__)

client = Minio(
    os.environ.get("MINIO_HOST", "minio:9000"),
    access_key=os.environ["MINIO_ACCESS_KEY"],
    secret_key=os.environ["MINIO_SECRET_KEY"],
    secure=False,
)
BUCKET = os.environ["MINIO_BUCKET"]


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/files")
def list_files():
    objects = client.list_objects(BUCKET, recursive=True)
    return jsonify([o.object_name for o in objects])


@app.post("/files")
def upload_file():
    f = request.files.get("file")
    if not f:
        return {"error": "file field is required"}, 400
    client.put_object(
        BUCKET, f.filename, f.stream, length=-1, part_size=10 * 1024 * 1024
    )
    return {"uploaded": f.filename}, 201


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
