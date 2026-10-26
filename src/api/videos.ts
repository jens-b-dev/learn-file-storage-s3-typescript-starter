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
import { unlink } from "fs/promises";

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

    const aspectRatio = await getVideoAspectRatio(tempFilePath);
    const fastTempFilePath = await processVideoForFastStart(tempFilePath);

    const key = `${aspectRatio}/${videoId}.mp4`;
    await uploadVideoToS3(cfg, key, fastTempFilePath, "video/mp4");

    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
    video.videoURL = videoURL;
    updateVideo(cfg.db, video);

    await Promise.all([
        rm(tempFilePath, { force: true }),
        rm(`${tempFilePath}.processed`, { force: true }),
    ]);

    return respondWithJSON(200, null);
}

export async function getVideoAspectRatio(filePath: string) {
    const proc = Bun.spawn(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            filePath,
        ],
        {
            stderr: "pipe",
            stdout: "pipe",
        },
    );

    if ((await proc.exited) !== 0) {
        const stderrText = await new Response(proc.stderr).text();

        throw new BadRequestError(stderrText);
    }

    const stdoutParsed = JSON.parse(await new Response(proc.stdout).text());
    const videoWidth = stdoutParsed.streams[0].width;
    const videoHeight = stdoutParsed.streams[0].height;

    const ratio = videoWidth / videoHeight;
    const targetLandscape = 16 / 9;
    const targetPortrait = 9 / 16;
    const tolerance = 0.01;

    if (Math.abs(ratio - targetLandscape) < tolerance) {
        return "landscape";
    } else if (Math.abs(ratio - targetPortrait) < tolerance) {
        return "portrait";
    } else {
        return "other";
    }
}

export async function processVideoForFastStart(inputFilePath: string) {
    const outputFilePath = inputFilePath + ".processed";

    await unlink(outputFilePath);

    const command = Bun.spawn(
        [
            "ffmpeg",
            "-i",
            inputFilePath,
            "-movflags",
            "faststart",
            "-map_metadata",
            "0",
            "-codec",
            "copy",
            "-f",
            "mp4",
            outputFilePath,
        ],
        {
            stderr: "pipe",
        },
    );

    const errorText = await new Response(command.stderr).text();
    const exitCode = await command.exited;

    if (exitCode !== 0) {
        await unlink(outputFilePath);

        throw new Error(`FFmpeg error: ${errorText}`);
    }

    return outputFilePath;
}
