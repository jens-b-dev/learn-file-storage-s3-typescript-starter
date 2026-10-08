import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

type Thumbnail = {
    data: ArrayBuffer;
    mediaType: string;
};

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
    const { videoId } = req.params as { videoId?: string };
    if (!videoId) {
        throw new BadRequestError("Invalid video ID");
    }

    const token = getBearerToken(req.headers);
    const userID = validateJWT(token, cfg.jwtSecret);

    console.log("uploading thumbnail for video", videoId, "by user", userID);

    // TODO: implement the upload here
    const requestData = await req.formData();
    const requestThumbnail = requestData.get("thumbnail");

    if ((requestThumbnail instanceof File) === false) {
        throw new BadRequestError("Thumnail is not of file type");
    }

    const MAX_UPLOAD_SIZE = 10 << 20; // 10,485,760 bytes = 10MB
    if (requestThumbnail.size > MAX_UPLOAD_SIZE) {
        throw new BadRequestError("Thumbnail size is to big");
    }

    const mediaType = requestThumbnail.type;

    const thumbnailData = await requestThumbnail.arrayBuffer();
    const thumbnailBuffer = Buffer.from(thumbnailData);
    const base64ThumbnailBufferString = thumbnailBuffer.toString("base64");
    const dataUrl = `data:${mediaType};base64,${base64ThumbnailBufferString}`;
    const video = getVideo(cfg.db, videoId);
    if (video?.userID !== userID) {
        throw new UserForbiddenError("Forbidden: Not the video owner");
    }

    const thumbnail: Thumbnail = {
        data: thumbnailData,
        mediaType
    }

    video.thumbnailURL = dataUrl;

    updateVideo(cfg.db, video)


    return respondWithJSON(200, video);
}
