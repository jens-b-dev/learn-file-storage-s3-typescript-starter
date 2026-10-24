import { respondWithJSON } from "./json";

import { rm } from "fs/promises";
import path from "path";
import { type ApiConfig } from "../config";
import { type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { getAssetDiskPath, mediaTypeToExt } from "./assets";
import { uploadVideoToS3 } from "../s3";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
    const { videoId } = req.params as { videoId?: string };
    if (!videoId) {
        throw new BadRequestError("Invalid video ID");
    }

    const token = getBearerToken(req.headers);
    const userID = validateJWT(token, cfg.jwtSecret);

    const video = getVideo(cfg.db, videoId);
    if (!video) {
        throw new NotFoundError("Couldn't find video");
    }
    if (video.userID !== userID) {
        throw new UserForbiddenError("Not authorized to update this video");
    }

    const formData = await req.formData();
    const file = formData.get("video");
    if (!(file instanceof File)) {
        throw new BadRequestError("Video file missing");
    }

    const MAX_UPLOAD_SIZE = 1 << 30;
    if (file.size > MAX_UPLOAD_SIZE) {
        throw new BadRequestError(
            `Video file exceeds the maximum allowed size of 1GB`,
        );
    }

    const mediaType = file.type;
    if (mediaType !== "video/mp4") {
        throw new BadRequestError("Invalid file type. Only mp4 allowed.");
    }

    const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
    await Bun.write(tempFilePath, file);

    let key = `${videoId}.mp4`;
    await uploadVideoToS3(cfg, key, tempFilePath, "video/mp4");

    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
    video.videoURL = videoURL;
    updateVideo(cfg.db, video);

    await Promise.all([rm(tempFilePath, { force: true })]);

    return respondWithJSON(200, null);
}
