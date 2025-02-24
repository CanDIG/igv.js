/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2016 University of California San Diego
 * Author: Jim Robinson
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import TDFReader from "./tdfReader.js"
import GenomicInterval from "../genome/genomicInterval.js"

class TDFSource {

    constructor(config, genome) {
        this.genome = genome
        this.windowFunction = config.windowFunction || "mean"
        this.reader = new TDFReader(config, genome)
    }

    async getFeatures({chr, start, end, bpPerPixel}) {

        if (chr.toLowerCase() === "all") {
            const wgFeatures = []
            const genome = this.genome
            const chrNames = this.genome.wgChromosomeNames
            if (chrNames) {
                for (let c of genome.wgChromosomeNames) {
                    const len = genome.getChromosome(c).bpLength
                    bpPerPixel = len / 1000
                    const chrFeatures = await this._getFeatures(c, 0, len, bpPerPixel)
                    if (chrFeatures) {
                        for (let f of chrFeatures) {
                            const wg = Object.assign({}, f)
                            wg.chr = "all"
                            wg.start = genome.getGenomeCoordinate(f.chr, f.start)
                            wg.end = genome.getGenomeCoordinate(f.chr, f.end)
                            wg._f = f
                            wgFeatures.push(wg)
                        }
                    }
                }
            }
            return wgFeatures

        } else {
            return this._getFeatures(chr, start, end, bpPerPixel)
        }
    }

    async _getFeatures(chr, start, end, bpPerPixel) {
        const genomicInterval = new GenomicInterval(chr, start, end)
        const genome = this.genome


        if (!this.rootGroup) {
            this.rootGroup = await this.reader.readRootGroup()
            if (!this.normalizationFactor) {
                const totalCount = this.rootGroup.totalCount
                if (totalCount) {
                    this.normalizationFactor = 1.0e6 / totalCount
                }
            }
        }

        genomicInterval.bpPerPixel = bpPerPixel
        const zoom = zoomLevelForScale(chr, bpPerPixel, genome)
        let queryChr = this.reader.chrAliasTable[chr]
        let maxZoom = this.reader.maxZoom
        if (queryChr === undefined) queryChr = chr
        if (maxZoom === undefined) maxZoom = -1

        const wf = zoom > maxZoom ? "raw" : this.windowFunction
        const dataset = await this.reader.readDataset(queryChr, wf, zoom)
        if (dataset == null) {
            return []
        }

        const tileWidth = dataset.tileWidth
        const startTile = Math.floor(start / tileWidth)
        const endTile = Math.floor(end / tileWidth)
        const NTRACKS = 1   // TODO read this
        const tiles = await this.reader.readTiles(dataset.tiles.slice(startTile, endTile + 1), NTRACKS)
        const features = []
        for (let tile of tiles) {
            switch (tile.type) {
                case "bed":
                    decodeBedTile(tile, chr, start, end, bpPerPixel, features)
                    break
                case "variableStep":
                    decodeVaryTile(tile, chr, start, end, bpPerPixel, features)
                    break
                case "fixedStep":
                    decodeFixedTile(tile, chr, start, end, bpPerPixel, features)
                    break
                default:
                    throw ("Unknown tile type: " + tile.type)
            }
        }
        features.sort(function (a, b) {
            return a.start - b.start
        })

        return features
    }

    supportsWholeGenome() {
        return true
    }
}

function decodeBedTile(tile, chr, bpStart, bpEnd, bpPerPixel, features) {

    const nPositions = tile.nPositions
    const starts = tile.start
    const ends = tile.end
    const data = tile.data[0]   // Single track for now
    for (let i = 0; i < nPositions; i++) {
        const s = starts[i]
        const e = ends[i]
        if (e < bpStart) continue
        if (s > bpEnd) break
        features.push({
            chr: chr,
            start: s,
            end: e,
            value: data[i]
        })
    }
}

function decodeVaryTile(tile, chr, bpStart, bpEnd, bpPerPixel, features) {

    const nPositions = tile.nPositions
    const starts = tile.start
    const span = tile.span
    const data = tile.data[0]   // Single track for now
    for (let i = 0; i < nPositions; i++) {
        const s = starts[i]
        const e = s + span
        if (e < bpStart) continue
        if (s > bpEnd) break
        features.push({
            chr: chr,
            start: s,
            end: e,
            value: data[i]
        })
    }
}

function decodeFixedTile(tile, chr, bpStart, bpEnd, bpPerPixel, features) {

    const nPositions = tile.nPositions
    let s = tile.start
    const span = tile.span
    const data = tile.data[0]   // Single track for now

    for (let i = 0; i < nPositions; i++) {
        const e = s + span
        if (s > bpEnd) break
        if (e >= bpStart) {
            if (!Number.isNaN(data[i])) {
                features.push({
                    chr: chr,
                    start: s,
                    end: e,
                    value: data[i]
                })
            }
        }
        s = e
    }
}


var log2 = Math.log(2)

function zoomLevelForScale(chr, bpPerPixel, genome) {

    // Convert bpPerPixel to IGV "zoom" level.   This is a bit convoluted,  IGV computes zoom levels assuming
    // display in a 700 pixel window.  The fully zoomed out view of a chromosome is zoom level "0".
    // Zoom level 1 is magnified 2X,  and so forth

    var chrSize = genome.getChromosome(chr).bpLength

    return Math.ceil(Math.log(Math.max(0, (chrSize / (bpPerPixel * 700)))) / log2)
}

export default TDFSource
