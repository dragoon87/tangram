// Text rendering style

import Geo from '../../geo';
import {Style} from '../style';
import {Points} from '../points/points';
import Collision from '../../labels/collision';
import LabelPoint from '../../labels/label_point';
import LabelLine from '../../labels/label_line';
import gl from '../../gl/constants'; // web workers don't have access to GL context, so import all GL constants
import VertexLayout from '../../gl/vertex_layout';

export let TextStyle = Object.create(Points);

Object.assign(TextStyle, {
    name: 'text',
    super: Points,
    built_in: true,

    init(options = {}) {
        Style.init.call(this, options);

        var attribs = [
            { name: 'a_position', size: 4, type: gl.SHORT, normalized: false },
            { name: 'a_shape', size: 4, type: gl.SHORT, normalized: false },
            { name: 'a_texcoord', size: 2, type: gl.UNSIGNED_SHORT, normalized: true },
            { name: 'a_offset', size: 2, type: gl.SHORT, normalized: false },
            { name: 'a_color', size: 4, type: gl.UNSIGNED_BYTE, normalized: true },
            { name: 'a_angles', size: 4, type: gl.SHORT, normalized: false },
            { name: 'a_offsets', size: 4, type: gl.UNSIGNED_SHORT, normalized: false },
            { name: 'a_pre_angles', size: 4, type: gl.BYTE, normalized: false },
            { name: 'a_selection_color', size: 4, type: gl.UNSIGNED_BYTE, normalized: true }
        ];

        this.vertex_layout = new VertexLayout(attribs);

        // Shader defines
        this.setupDefines();

        // Omit some code for SDF-drawn shader points
        this.defines.TANGRAM_HAS_SHADER_POINTS = false;

        // Indicate vertex shader should apply zoom-interpolated offsets and angles for curved labels
        this.defines.TANGRAM_CURVED_LABEL = true;

        this.reset();
    },

    /**
     * A "template" that sets constant attibutes for each vertex, which is then modified per vertex or per feature.
     * A plain JS array matching the order of the vertex layout.
     */
    makeVertexTemplate(style, mesh) {
        this.super.makeVertexTemplate.apply(this, arguments);
        let vertex_layout = mesh.vertex_data.vertex_layout;

        this.fillVertexTemplate(vertex_layout, 'a_pre_angles', 0, { size: 4 });
        this.fillVertexTemplate(vertex_layout, 'a_offsets', 0, { size: 4 });
        this.fillVertexTemplate(vertex_layout, 'a_angles', 0, { size: 4 });

        return this.vertex_template;
    },

    reset() {
        this.queues = {};
        this.resetText();
    },

    // Override to queue features instead of processing immediately
    addFeature (feature, draw, context) {
        let tile = context.tile;
        if (tile.generation !== this.generation) {
            return;
        }

        let type = feature.geometry.type;
        draw.can_articulate = (type === "LineString" || type === "MultiLineString");

        // supersample text rendering for angled labels, to improve clarity
        draw.supersample_text = (type === "LineString" || type === "MultiLineString");

        let q = this.parseTextFeature(feature, draw, context, tile);
        if (!q) {
            return;
        }

        // text can be an array if a `left` or `right` orientation key is defined for the text source
        // in which case, push both text sources to the queue
        if (q instanceof Array){
            q.forEach(q => {
                q.feature = feature;
                q.context = context;
                q.layout.vertex = false; // vertex placement option not applicable to standalone labels
                this.queueFeature(q, tile); // queue the feature for later processing
            });
        }
        else {
            q.feature = feature;
            q.context = context;
            q.layout.vertex = false; // vertex placement option not applicable to standalone labels
            this.queueFeature(q, tile); // queue the feature for later processing
        }

        // Register with collision manager
        Collision.addStyle(this.name, tile.id);
    },

    // Override
    endData (tile) {
        let queue = this.queues[tile.id];
        delete this.queues[tile.id];

        return this.collideAndRenderTextLabels(tile, this.name, queue).
            then(({ labels, texts, textures }) => {
                if (labels && texts) {
                    this.texts[tile.id] = texts;

                    // Build queued features
                    labels.forEach(q => {
                        let text_settings_key = q.text_settings_key;
                        let text_info =
                            this.texts[tile.id][text_settings_key] &&
                            this.texts[tile.id][text_settings_key][q.text];

                        // setup styling object expected by Style class
                        let style = this.feature_style;
                        style.label = q.label;

                        if (text_info.text_settings.can_articulate){
                            // unpack logical sizes of each segment into an array for the style
                            style.size = {};
                            style.texcoords = {};

                            if (q.label.type === 'straight'){
                                style.size.straight = text_info.size.logical_size;
                                style.texcoords.straight = text_info.texcoords.straight;
                                style.label_texture = textures[text_info.texcoords.straight.texture_id];
                            }
                            else{
                                style.size.curved = text_info.segment_sizes.map(function(size){ return size.logical_size; });
                                style.texcoords_stroke = text_info.texcoords_stroke;
                                style.texcoords.curved = text_info.texcoords.curved;
                                style.label_textures = text_info.texcoords.curved.map(t => textures[t.texture_id]);
                            }
                        }
                        else {
                            style.size = text_info.size.logical_size;
                            style.texcoords = text_info.align[q.label.align].texcoords;
                            style.label_texture = textures[text_info.align[q.label.align].texture_id];
                        }

                        Style.addFeature.call(this, q.feature, q.draw, q.context);
                    });
                }
                this.freeText(tile);

                // Finish tile mesh
                return Style.endData.call(this, tile).then(tile_data => {
                    if (tile_data) {
                        // Attach tile-specific label atlas to mesh as a texture uniform
                        if (textures && textures.length) {
                            tile_data.textures.push(...textures); // assign texture ownership to tile
                        }

                        // Always apply shader blocks to standalone text
                        for (let m in tile_data.meshes) {
                            tile_data.meshes[m].uniforms.u_apply_color_blocks = true;
                        }
                    }

                    return tile_data;
                });
            });
    },

    // Sets up caching for draw properties
    _preprocess (draw) {
        return this.preprocessText(draw);
    },

    // Implements label building for TextLabels mixin
    buildTextLabels (tile, feature_queue) {
        let labels = [];
        for (let f=0; f < feature_queue.length; f++) {
            let fq = feature_queue[f];
            let text_info = this.texts[tile.id][fq.text_settings_key][fq.text];
            let feature_labels;

            fq.layout.vertical_buffer = text_info.vertical_buffer;

            if (text_info.text_settings.can_articulate){
                var sizes = text_info.segment_sizes.map(size => size.collision_size);
                fq.layout.no_curving = text_info.no_curving;
                feature_labels = this.buildLabels(sizes, fq.feature.geometry, fq.layout, text_info.size.collision_size);
            }
            else {
                feature_labels = this.buildLabels(text_info.size.collision_size, fq.feature.geometry, fq.layout);
            }
            for (let i = 0; i < feature_labels.length; i++) {
                let fql = Object.create(fq);
                fql.label = feature_labels[i];
                labels.push(fql);
            }
        }
        return labels;
    },

    // Builds one or more labels for a geometry
    buildLabels (size, geometry, layout, total_size) {
        let labels = [];

        if (geometry.type === "LineString") {
            Array.prototype.push.apply(labels, this.buildLineLabels(geometry.coordinates, size, layout, total_size));
        } else if (geometry.type === "MultiLineString") {
            let lines = geometry.coordinates;
            for (let i = 0; i < lines.length; ++i) {
                Array.prototype.push.apply(labels, this.buildLineLabels(lines[i], size, layout, total_size));
            }
        } else if (geometry.type === "Point") {
            labels.push(new LabelPoint(geometry.coordinates, size, layout));
        } else if (geometry.type === "MultiPoint") {
            let points = geometry.coordinates;
            for (let i = 0; i < points.length; ++i) {
                labels.push(new LabelPoint(points[i], size, layout));
            }
        } else if (geometry.type === "Polygon") {
            let centroid = Geo.centroid(geometry.coordinates);
            labels.push(new LabelPoint(centroid, size, layout));
        } else if (geometry.type === "MultiPolygon") {
            let centroid = Geo.multiCentroid(geometry.coordinates);
            labels.push(new LabelPoint(centroid, size, layout));
        }

        return labels;
    },
	getAngle(p, q) {
        let angle = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : 0;
        return angle === 'auto' ? Math.atan2(q[0] - p[0], q[1] - p[1]) : angle;
    },
        
    getLineLength(line) {
        let distance = 0;
        for (let i = 0; i < line.length - 1; i ++) {
            distance += this.norm(line[i], line[i + 1]);
        }
        return distance;
    },

    norm(p, q) {
        return Math.sqrt(Math.pow(p[0] - q[0], 2) + Math.pow(p[1] - q[1], 2));
    },
    // Build one or more labels for a line geometry
    buildLineLabels (line, size, layout, total_size) {
        let labels = [];
		if (layout.dash && layout.dash !== null && typeof layout.dash !== "undefined")
        {
            let tmp_length = 0;
            let total_pos = 0;
            let dash_count = layout.dash.length;
            let length = this.getLineLength(line);
            let points = [];
            while (tmp_length < length)
            {
                let cur_pos = total_pos % dash_count;
                if (tmp_length > 0 && cur_pos % 2 === 0)
                {
                    let distance = 0;
                    let point = null;
                    let angle = 'auto';
                    //console.log("tmp_length:" + tmp_length);
                    for (let i = 0; i < line.length - 1; i ++)
                    {
                        let tmp_distance = this.norm(line[i], line[i + 1]);
                        if (distance + tmp_distance < tmp_length)
                        {
                            distance += tmp_distance;
                            continue;
                        }
                        if (points.indexOf(i) > -1)
                            console.log("test dup :" + i);
                        else
                            points.push(i);
                        //angle = Math.atan((line[i + 1][1] - line[i][1]) / (line[i + 1][0] - line[i][0]));
                        angle = this.getAngle(line[i], line[i + 1], angle);
                        //console.log("tmp_distance :" + tmp_distance);
                        //console.log("tmp_length - distance :" + (Math.cos(angle) * (tmp_length - distance)));
                        point = [ line[i][0] + Math.round(Math.sin(angle) * (tmp_length - distance)), line[i][1] + Math.round(Math.cos(angle) * (tmp_length - distance)) ];
                        //console.log(line[i] + "---" + point + "---" + line[i + 1]);
                        let dy = Math.round(Math.cos(angle) * layout.dash[cur_pos + 1] * 5 * layout.units_per_pixel);
                        let dx = Math.round(Math.sin(angle) * layout.dash[cur_pos + 1] * 5 * layout.units_per_pixel);
                        let p1 = [ point[0] - dx, point[1] - dy ];
                        let p2 = [ point[0] + dx, point[1] + dy ];
                        //console.log(p1 + "---" + point + "---" + p2);
                        let label = _label_line2.default.create(size, total_size, [ p1, point, p2 ], layout);
                        if (label) {
                            //label.position = point;
                            //label.angle = angle;
                            labels.push(label);
                        }
                    
                        break;
                    }
                    //var label = _label_line2.default.create(size, total_size, line_segment, layout);
                    //layout.angle = angle;
                    //console.log("angle:" + angle);
                    //console.log("point:" + line[1]);
                }
                
                tmp_length += layout.dash[cur_pos] * 5 * layout.units_per_pixel;
                total_pos ++;
            }
            
            /*console.log("points:" + points);
            for (var j = 0; j < points.length; j ++)
            //if (points.length > 0)
            {
                //var j = parseInt(points.length / 2);
                point = null;
                point = line[points[j]];
                if (point === null)
                    console.log("line:" + line);
                else
                {
                    var label = _label_line2.default.create(size, total_size, [ line[points[j]], line[points[j] + 1] ], layout);
                    if (label) {
                        labels.push(label);
                    }
                    /*console.log("point:" + point + "---size:" + size + "---layout" + layout);
                    var pLabel = new _label_point2.default(point, size, layout);
                    if (pLabel)
                        labels.push(pLabel);
                }
            }*/

            return labels;
        }
        let subdiv = Math.min(layout.subdiv, line.length - 1);
        if (subdiv > 1) {
            // Create multiple labels for line, with each allotted a range of segments
            // in which it will attempt to place
            let seg_per_div = (line.length - 1) / subdiv;
            for (let i = 0; i < subdiv; i++) {
                let start = Math.floor(i * seg_per_div);
                let end = Math.floor((i + 1) * seg_per_div) + 1;
                let line_segment = line.slice(start, end);

                let label = LabelLine.create(size, total_size, line_segment, layout);
                if (label){
                    labels.push(label);
                }
            }
        }

        // Consider full line for label placement if no subdivisions requested, or as last resort if not enough
        // labels placed (e.g. fewer than requested subdivisions)
        // TODO: refactor multiple label placements per line / move into label placement class for better effectiveness
        if (labels.length < subdiv) {
            let label = LabelLine.create(size, total_size, line, layout);
            if (label){
                labels.push(label);
            }
        }
        return labels;
    },

    // Override to restore base class default implementations
    vertexLayoutForMeshVariant: Style.vertexLayoutForMeshVariant,
    meshVariantTypeForDraw: Style.meshVariantTypeForDraw

});

TextStyle.texture_id = 0; // namespaces per-tile label textures
