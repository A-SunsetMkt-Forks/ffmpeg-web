import ConversionOptions from "../TabOptions/ConversionOptions";
import EncoderInfo from "../TabOptions/EncoderInfo";
import ffmpeg from "./FFmpegClass";
import FFmpegFileNameHandler from "./FFmpegHandleFileName";
import FfmpegCommonOperations from "./FFmpegLoadWrite";
import { conversionFailedDate } from "../Writables";
import Settings from "../TabOptions/Settings";
import { get } from "svelte/store";

interface OperationProps {
    file: Uint8Array | string,
    extension: string,
    suggestedFileName: string
}
interface CustomOptions {
    albumArtReEncode?: boolean,
    addedFromInput?: boolean,
    suggestedFileExtension?: string,
    albumArtName?: string,
    getNameWithFfmpegHandler?: boolean,
    /**
     * Disable trimming (cutting the length of the vioeo) for the current operation
     */
    disableCut?: boolean
}
interface FilterElaboration {
    props: (string | number | boolean)[],
    disableValues: (string | number | boolean | null)[][],
    syntax: string,
    custom?: boolean
}
/**
 * The FfmpegHandler class permits to get the user preferences as FFmpeg command; and to run FFmpeg commands by following the user's preferences.
 * @constructor Must be provided a `ffmpeg` Object, and it's possible to provide a `CustomOptions` object.
 */
export default class FfmpegHandler {
    #conversion = ConversionOptions;
    constructor(ffmpeg: ffmpeg, options?: CustomOptions) {
        this.#conversion = { ...ConversionOptions }; // Copy conversion preferences so that, even if they are modified by the user later, the conversion will be done with the same arguments
        if (options?.disableCut) this.#conversion.trimOptions.id = 0;
        this.ffmpeg = ffmpeg;
        this.flags = options ?? {};
    }
    /**
     * Custom flags
     */
    flags: CustomOptions;
    /**
     * If the action being ran is a video/audio conversion using the Main Encoding UI (the first one). This is used so that the output container can be changed if needed.
     */
    #isMainVideoEncoding = false;
    /**
     * The files that'll be added to the FFmpeg script
     */
    #files: File[] = [];
    /**
     * If the output file is an image. This is used especially for codec fetching, since everything else is the same as video output.
     */
    #isImg: boolean | undefined;
    /**
     * The `ffmpeg` object for operations
     */
    ffmpeg: ffmpeg;
    /**
     * The array of output files to return when the conversion is completed
     */
    #operationArray: OperationProps[] = [];
    /**
     * The number of multiple timestamps that have been encoded
     */
    #multipleTimestampsDone = 0;
    /**
     * Get the start and the end of the next file part
     * @returns an Object with {`suggestedFileName`; `start` (the "-ss" ffmpeg property); `-to` (the "-to" ffmpeg property)}
     */
    #multipleTimestampsHandler = () => {
        /**
         * The string[] with each file to split
         */
        const textSplit = this.#conversion.trimOptions.multipleTimestamps.text.split("\n");
        const [first, second] = textSplit[this.#multipleTimestampsDone].split(this.#conversion.trimOptions.multipleTimestamps.divider);
        let [third, fourth] = ["", ""];
        if (textSplit[this.#multipleTimestampsDone + 1]) [third, fourth] = textSplit[this.#multipleTimestampsDone + 1].split(this.#conversion.trimOptions.multipleTimestamps.divider); // This might also be undefined if it's the last item to be converted
        return {
            suggestedFileName: this.#conversion.trimOptions.multipleTimestamps.timestampAtLeft ? second : first,
            start: this.#conversion.trimOptions.multipleTimestamps.timestampAtLeft ? first : second,
            to: this.#conversion.trimOptions.multipleTimestamps.timestampAtLeft ? third : fourth
        }
    }
    /**
     * This MUST be called after saving the file. This resets the `operationArray` array, that contains all the file that must be downloaded.
     * Without resetting this, the files from the previous conversion(s) will be downloaded again.
     * Also, this resets the "multipleTimestampsDone" number, so that multiple timestamps can work with multiple files.
     */
    operationComplete = () => {
        this.#operationArray = [];
        this.#multipleTimestampsDone = 0;
    }
    /**
     * 
     * @param command the string[] with the commands to run
     * @param suggestedFileName if provided, the `suggestedFileName` property of the return object will be this string. Otherwise, the script will provide its file name.
     * @param skipMultipleFiles if true, the "trimOptions" passed will be ignored
     * @returns an `OperationProps` object, with the `File` string path (if native) or Uint8Array (if WebAssembly), its `extension` and the `suggestedFileName`
     */
    start = async (command: string[], suggestedFileName = this.flags.addedFromInput && !this.flags.getNameWithFfmpegHandler ? command[command.length - 1] : FFmpegFileNameHandler(this.#files[0], this.#isMainVideoEncoding && this.#conversion.outputContainerChanged ? this.#conversion.outputContainerRequested : undefined), skipMultipleFiles?: boolean) => {
        if (this.#files.length === 0) throw new Error("Please set up files using the addFiles function");
        /**
         * An UUID will be used for this conversion to make the output file string unique.
         * In this way, we'll avoid issues with simultaneous conversions.
         */
        const operationUuid = crypto.randomUUID();
        /**
         * Since the `command` string[] will be edited for multiple timestamps, it's important to save the original command if it's necessary to run the script another time (e.g. for encoding the next timestamp)
         */
        const originalCommandStorage = [...command];
        await this.ffmpeg.load();
        await FfmpegCommonOperations(this.ffmpeg, this.#files); // Load and write files to the virtual File System
        const elaborationType = this.#isImg ? "image" : this.#conversion.isVideoSelected ? "video" : "audio"; // We need to fetch the file extension. By knowing the output file type, we can ask EncoderInfo to get the extension. If nothing is found, we'll use the extension of the first file.
        let outputFileExtension = this.flags.suggestedFileExtension ?? (this.flags.addedFromInput ? command[command.length - 1].substring(command[command.length - 1].lastIndexOf(".") + 1) : EncoderInfo[elaborationType].get(this.#conversion[`${elaborationType}TypeSelected`])?.extension ?? this.#files[0].name.substring(this.#files[0].name.lastIndexOf(".") + 1));
        if (outputFileExtension === "!") outputFileExtension = this.#files[0].name.substring(this.#files[0].name.lastIndexOf(".") + 1); // The extension might be "!" if the "Copy video" or "Copy audio" options are selected
        if (this.#isMainVideoEncoding && this.#conversion.outputContainerChanged) outputFileExtension = this.#conversion.outputContainerRequested; // The user has set a different extension from the "Main Encoding" UI, so that should be used.
        /**
         * If further timestamps needs to be elaborated, and therefore the build script needs to be run again.
         */
        let necessaryNextBuild = false;
        if (!skipMultipleFiles) {
            switch (this.#conversion.trimOptions.id) { // "1" for single timestamp, "2" for multiple timestamps
                case 1: {
                    command.splice(command.lastIndexOf("-i") + 2, 0, "-ss", this.#conversion.trimOptions.singleTimestamp[0], `-to`, this.#conversion.trimOptions.singleTimestamp[1]);
                    break;
                }
                case 2: {
                    const timestamps = this.#multipleTimestampsHandler();
                    command.splice(command.lastIndexOf("-i") + 2, 0, `-ss`, timestamps.start, ...(timestamps.to !== "" ? [`-to`, timestamps.to] : []), ...(this.#conversion.trimOptions.multipleTimestamps.smartMetadata ? ["-metadata", `title=${timestamps.suggestedFileName}`, "-metadata", `track=${this.#conversion.trimOptions.multipleTimestamps.startFrom}`] : []));
                    this.#conversion.trimOptions.multipleTimestamps.smartMetadata && this.#conversion.trimOptions.multipleTimestamps.startFrom++; // Add a number to the track
                    suggestedFileName = `${timestamps.suggestedFileName}.${outputFileExtension}`; // Get the file name provided when creating multiple timestamps
                    necessaryNextBuild = timestamps.to !== "";
                    break;
                }
            }
        }
        if (command[command.length - 1].startsWith("__FfmpegWebExclusive__0__$ReplaceWithUUID")) command[command.length - 1] = command[command.length - 1].replace("$ReplaceWithUUID", operationUuid); // Add the UUID to the output file
        !this.flags.addedFromInput && command.push(`__FfmpegWebExclusive__0__${operationUuid}.${outputFileExtension}`); // Add the output file name for the first command if not provided (it's provided only if adding from input)
        /**
         * The number of the __FfmpegWebExclusive__[x] file to read, since sometimes more than 1 file might be created
         */
        let suggestedFileRead = "0";
        await this.ffmpeg.exec(command);
        if ((!this.flags.addedFromInput && this.flags.albumArtReEncode) || this.flags.albumArtName) {
            const currentFailed = get(conversionFailedDate);
            try {
                if (outputFileExtension === "ogg") throw new Error();
                await this.ffmpeg.exec([`-i`, this.flags.albumArtName ?? FFmpegFileNameHandler(this.#files[0]), `-frames:v`, `1`, `__FfmpegWebExclusive__1__${operationUuid}.jpg`]); // Get album art
                await this.ffmpeg.exec(["-i", this.flags.albumArtName ? command[command.length - 1] : `__FfmpegWebExclusive__0__${operationUuid}.${outputFileExtension}`, "-i", `__FfmpegWebExclusive__1__${operationUuid}.jpg`, "-map", "0", "-map", "1", "-c", "copy", "-disposition:v:0", "attached_pic", `__FfmpegWebExclusive__2__${operationUuid}.${outputFileExtension}`]); // And add it to the output file
                if (currentFailed !== get(conversionFailedDate)) throw new Error();
                suggestedFileRead = "2";
            } catch (ex) {
                console.warn("Failed album art extraction!");
            }
        }
        if (!this.flags.addedFromInput && this.#conversion.forceCopyMetadata) { // Copy the metadata from the first file to the last one
            try {
                const currentFailed = get(conversionFailedDate);
                await this.ffmpeg.exec([`-i`, `__FfmpegWebExclusive__${suggestedFileRead}__${operationUuid}.${outputFileExtension}`, `-i`, FFmpegFileNameHandler(this.#files[0]), "-map", "0", "-map_metadata", "1", "-c", "copy", `__FfmpegWebExclusive__3__${operationUuid}.${outputFileExtension}`]);
                if (currentFailed !== get(conversionFailedDate)) throw new Error();
                suggestedFileRead = "3";
            } catch (ex) {
                console.warn("Failed copying metadata!");
            }

        }
        const readFileName = this.flags.addedFromInput && !this.flags.albumArtName && !command[command.length - 1].startsWith("__FfmpegWebExclusive__0__$ReplaceWithUUID") ? command[command.length - 1] : `__FfmpegWebExclusive__${suggestedFileRead}__${operationUuid}.${outputFileExtension}`;
        const file = await this.ffmpeg.readFile(readFileName) ?? readFileName;
        try {
            for (let i = 0; i < +suggestedFileRead + 1; i++) { // Check each ffmpegWebExlusive file and, if it's not the output file, delete it.
                const output = `__FfmpegWebExclusive__${i}__${operationUuid}.${i === 1 ? "jpg" : outputFileExtension}`;
                output !== file && await this.ffmpeg.removeFile(output); // This comparison will be true only if the user is using the Electron version, since otherwise the result will be a Uint8Array. Since the user is using Electron, the file must not be deleted, since it'll be moved in the next step.
            }
        } catch (ex) {
            console.warn("Failed FfmpegWebExclusive cleanup");
        }
        this.#operationArray.push({ file, extension: outputFileExtension, suggestedFileName });
        if (necessaryNextBuild) {
            this.#multipleTimestampsDone++;
            Settings.exit.afterTimestamp && this.ffmpeg.exit();
            await this.start(originalCommandStorage);
        }
        return this.#operationArray;
    }
    /**
     * Add files to the FFmpeg script
     * @param file the Files to add
     */
    addFiles = (file: File[]) => (this.#files = file);
    /**
     * Get the syntax for a filter
     * @param filter the `FilterElaboration` object
     * @returns the string to add in the FFmpeg filters
     */
    #elaborateFilter = (filter: FilterElaboration) => {
        if (filter.custom) return filter.syntax;
        for (let i = 0; i < filter.props.length; i++) {
            if (filter.disableValues[i]?.indexOf(filter.props[i]) !== -1) return "";
            filter.syntax = filter.syntax.replace(`$ref[${i}]`, filter.props[i].toString());
        }
        return filter.syntax;
    }
    /**
     * Delete the filter comma if it's at the start, or at the end, of a filter text
     * @param str the string of the filter
     * @returns a string without the comma at the beginning or at the ned
     */
    #deleteCommaFromFilter: (str: string) => string = (str) => {
        if (str.startsWith(",")) str = str.substring(1);
        if (str.endsWith(",")) str = str.substring(0, str.length - 1);
        return (str.startsWith(",") || str.endsWith(",")) ? this.#deleteCommaFromFilter(str) : str;
    }
    /**
     * Get the content that should be added in the script to enable hardware acceleration
     * @param isImage if the video codec should be fetched from the image Map instead of the video Map
     * @param bitrate An object with a `{video: string}` property. By passing it, the video codec won't be added in the hardware acceleration object
     * @returns An object, with the `{beginning: string}` property that contains the parts needed to initialize hardware acceleration on the device (so, they must be added before anything else); and with the `{after: string}` property that contains the custom video quality for the current operation (so, they must be added)
     */
    hardwareAcceleration = (isImage?: boolean, bitrate?: { video: string }) => {
        const encoderInfo = EncoderInfo.video.get(this.#conversion.videoTypeSelected);
        const videoCodec = isImage ? this.#conversion.imageTypeSelected : encoderInfo ? encoderInfo[this.ffmpeg.native ? Settings.hardwareAcceleration.type as "nvidia" : "NoHardwareAcceleration"] ?? this.#conversion.videoTypeSelected : this.#conversion.videoTypeSelected; // Get library for hardware acceleration in case the user is encoding a video
        const currentObject = [];
        !bitrate && currentObject.push("-vcodec", videoCodec.startsWith("!") ? "copy" : videoCodec.replace("libxh264", "libx264"), this.#isImg ? "-q:v" : this.#conversion.videoOptions.useSlider ? "-crf" : "-b:v", this.#isImg ? this.#conversion.imageOptions.value : this.#conversion.videoOptions.useSlider ? this.#NaNPlaceholder(this.#conversion.videoOptions.value) : this.#conversion.videoOptions.value); // Add video codec and quality. In case a quality slider value is added, the input is sanitized.
        if (this.ffmpeg.native && (bitrate || (encoderInfo && encoderInfo[Settings.hardwareAcceleration.type as "nvidia"]))) { // Hardware acceleration available: add extra arguments
            switch (Settings.hardwareAcceleration.type) {
                case "apple":
                    currentObject.push("-qmin", !bitrate && this.#conversion.videoOptions.useSlider ? this.#NaNPlaceholder(this.#conversion.videoOptions.value) : bitrate ? "24" : "28", "-qmax", !bitrate && this.#conversion.videoOptions.useSlider ? this.#NaNPlaceholder(this.#conversion.videoOptions.value) : bitrate ? "24" : "28");
                    break;
                case "intel":
                    currentObject.push(...(!bitrate && this.#conversion.videoOptions.useSlider ? ["-global_quality", this.#NaNPlaceholder(this.#conversion.videoOptions.value)] : ["-b:v", bitrate?.video ?? this.#conversion.videoOptions.value, "-maxrate", bitrate?.video ?? this.#conversion.videoOptions.value]));
                    break;
                case "nvidia":
                    currentObject.push(...(!bitrate && this.#conversion.videoOptions.useSlider ? ["-crf", this.#NaNPlaceholder(this.#conversion.videoOptions.value)] : ["-maxrate", bitrate?.video ?? this.#conversion.videoOptions.value, "-bufsize", this.#conversion.videoOptions.maxRate]));
                    break;
                case "vaapi":
                    currentObject.push("-maxrate", bitrate?.video ?? this.#conversion.videoOptions.maxRate, "-bufsize", bitrate?.video ?? this.#conversion.videoOptions.maxRate, "-global_quality", bitrate ? "24" : this.#NaNPlaceholder(this.#conversion.videoOptions.value), "-qp", bitrate ? "24" : this.#NaNPlaceholder(this.#conversion.videoOptions.value));
                    break;
                case "amd":
                    currentObject.push(...(!bitrate && this.#conversion.videoOptions.useSlider ? ["-rc", "qvbr", "-qvbr_quality_level", this.#NaNPlaceholder(this.#conversion.videoOptions.value), "-qmin", this.#NaNPlaceholder(this.#conversion.videoOptions.value), "-qmax", this.#NaNPlaceholder(this.#conversion.videoOptions.value)] : ["-rc", "cbr", "-bufsize", bitrate?.video ?? this.#conversion.videoOptions.maxRate]));
                    break;
            }
        }

        return {
            beginning: Settings.hardwareAcceleration.additionalProps.map(text => text.display),
            after: currentObject
        }
    }
    /**
     * Use the OS's native audio encoder, if the user wants so. It's currently used only on macOS for their AudioToolbox's AAC and ALAC encoders.
     * @param encoder the audio encoder for this operation
     * @returns the audio encoder to use
     */
    #audioCodec = (encoder: string) => {
        const info = EncoderInfo.audio.get(encoder);
        if (Settings.hardwareAcceleration.audioToolbox && info?.apple) return info.apple;
        return encoder;
    }
    /**
     * Choose a quality option that could make sense for the video. If the user has chosen quality with a slider, this will return the selected value. Otherwise, it'll try to convert the provided bitrate with a plausible quality number
     * @param val the value that needs to be converted in a quality number
     * @returns a number that can be passed for quality
     */
    #NaNPlaceholder = (val: string) => {
        if (isNaN(+val)) return Math.max(0, Math.min(51, Math.floor(51 - (+(val.replace(/k/gi, "000").replace(/m/gi, "000000").match("/\d+/g") ?? ["2800000"])[0] / 100000)))).toString();
        return val;
    }
    /**
     * Get the script for FFmpeg conversion
     * @param isImage if the script needs to be built for image conversion
     * @returns a string[] with the command to run
     */
    build = (isImage?: boolean) => {
        this.#isImg = isImage;
        this.#isMainVideoEncoding = !isImage; // Currently, the "build" command is being ran only from the Image and the Video/Audio Encoding section
        /**
         * Get the parts for hardware acceleration to add in the script.
         */
        const hardwareAccelerationOptions = this.hardwareAcceleration(isImage);
        /**
         * The arary of commands to run
         */
        let currentObject: string[] = [...hardwareAccelerationOptions.beginning];
        if (this.#files.length === 0) throw new Error("Please set up files using the addFiles function")
        for (let file of this.#files) currentObject.push("-i", FFmpegFileNameHandler(file));
        if (this.#conversion.isVideoSelected || isImage) { // Video-specific arguments
            currentObject.push(...hardwareAccelerationOptions.after);
            let customFilter = "";
            if (this.#conversion.videoOptions.aspectRatio.isBeingEdited) { // Change aspect ratio and rotation
                this.#conversion.videoOptions.aspectRatio.height !== -1 && this.#conversion.videoOptions.aspectRatio.width !== -1 && currentObject.push(`-aspect`, `${this.#conversion.videoOptions.aspectRatio.width}/${this.#conversion.videoOptions.aspectRatio.height}`);
                this.#conversion.videoOptions.aspectRatio.rotation !== -1 && (customFilter += `,rotate=PI*${this.#conversion.videoOptions.aspectRatio.rotation}:oh=iw:ow=ih`);
            }
            if (!this.#conversion.videoOptions.fps.keepFps) this.#conversion.videoTypeSelected === "copy" ? currentObject.push(`-itsscale`, (this.#conversion.videoOptions.fps.inputFps / this.#conversion.videoOptions.fps.outputFps).toString()) : (customFilter += `,fps=${this.#conversion.videoOptions.fps.outputFps}`);
            this.#conversion.videoOptions.pixelSpace.change && this.#conversion.videoOptions.pixelSpace.with !== "" && currentObject.push(`-pix_fmt`, this.#conversion.videoOptions.pixelSpace.with);
            /**
             * All the video filters available in the "Video filters" dialog
             */
            const customVideoFilters: FilterElaboration[] = [{
                props: [this.#conversion.videoOptions.extraFilters.videoCut.width, this.#conversion.videoOptions.extraFilters.videoCut.height, this.#conversion.videoOptions.extraFilters.videoCut.positionX.replace("center-w", `(iw-${this.#conversion.videoOptions.extraFilters.videoCut.width}/2)`), this.#conversion.videoOptions.extraFilters.videoCut.positionY.replace("center-h", `(ih-${this.#conversion.videoOptions.extraFilters.videoCut.height}/2)`)],
                disableValues: [[-1, "", null], [-1, "", null], ["", null], ["", null]],
                syntax: `,crop=$ref[0]:$ref[1]:$ref[2]:$ref[3]`
            }, {
                props: [this.#conversion.videoOptions.extraFilters.deinterlace],
                disableValues: [[false]],
                syntax: `,yadif=0:0:0`
            }, {
                props: [this.#conversion.videoOptions.extraFilters.videoFilter],
                disableValues: [["none"]],
                syntax: `,curves=$ref[0]`
            }, {
                props: [this.#conversion.videoOptions.extraFilters.custom],
                disableValues: [[""]],
                syntax: `,${this.#conversion.videoOptions.extraFilters.custom}`,
                custom: true
            }];
            for (let filter of customVideoFilters) customFilter += this.#elaborateFilter(filter); // Elaborate custom filter syntax, and add it to the string
            if (customFilter.indexOf("format=") === -1 && Settings.hardwareAcceleration.type === "vaapi") customFilter += `${customFilter.endsWith(",") ? "" : ","}format=nv12`; // Required filter for VAAPI, since otherwise the conversion fails.
            if (customFilter.indexOf("hwupload") === -1 && Settings.hardwareAcceleration.type === "vaapi") customFilter += `${customFilter.endsWith(",") ? "" : ","}hwupload`; // Required filter for VAAPI, since otherwise the conversion fails.
            customFilter = this.#deleteCommaFromFilter(customFilter);
            customFilter.length !== 0 && currentObject.push(`-filter:v`, customFilter);
        } else currentObject.push("-vn");
        if (this.#conversion.isAudioSelected && !isImage) {
            currentObject.push(`-acodec`, this.#conversion.audioTypeSelected.startsWith("!") ? "copy" : this.#audioCodec(this.#conversion.audioTypeSelected));
            !EncoderInfo.audio.get(this.#conversion.audioTypeSelected)?.isLossless && currentObject.push(this.#conversion.audioOptions.useSlider ? "-qscale:a" : "-b:a", this.#conversion.audioOptions.useSlider ? Math.max(1, Math.min(+this.#conversion.audioOptions.value.replace(/\D/g, ""), 9)).toString() : this.#conversion.audioOptions.value);
            this.#conversion.audioOptions.channels !== -1 && currentObject.push(`-ac`, this.#conversion.audioOptions.channels.toString());
            let customFilter = "";
            /**
             * All the audio filters available in the "Audio filters" dialog
             */
            const customAudioFilters: FilterElaboration[] = [{
                props: [this.#conversion.audioOptions.extraFilters.audioDB],
                disableValues: [[0, null, ""]],
                syntax: `,volume=$ref[0]dB`
            }, {
                props: [this.#conversion.audioOptions.extraFilters.noiseRemoval.noise, this.#conversion.audioOptions.extraFilters.noiseRemoval.floor],
                disableValues: [[0, null, ""], [0, null, ""]],
                syntax: `,afftdn=nr=$ref[0]:nf=$ref[1]`
            }, {
                props: [this.#conversion.audioOptions.extraFilters.custom],
                disableValues: [[""]],
                syntax: `,${this.#conversion.audioOptions.extraFilters.custom}`,
                custom: true
            }]
            for (let filter of customAudioFilters) customFilter += this.#elaborateFilter(filter);
            customFilter = this.#deleteCommaFromFilter(customFilter);
            customFilter.length !== 0 && currentObject.push(`-filter:a`, customFilter);
            this.flags.albumArtReEncode = this.#conversion.audioOptions.keepAlbumArt;
        } else currentObject.push("-an");
        return currentObject;
    }
}