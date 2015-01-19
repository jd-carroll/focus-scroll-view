/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * @license MPL 2.0
 * @copyright Joseph Carroll <jdsalingerjr@gmail.com>
 */
define(function(require, exports, module) {
    'use strict';

    var OptionsManager = require('famous/core/OptionsManager');
    var Transform = require('famous/core/Transform');
    var Utility = require('famous/utilities/Utility');
    var EventHandler = require('famous/core/EventHandler');

    var ScrollEdgeStates = require('./ScrollEdgeStates');

    function FocusScrollLayout(options) {
        this.options = Object.create(FocusScrollLayout.DEFAULT_OPTIONS);
        this._optionsManager = new OptionsManager(this.options);
        if (options) this._optionsManager.setOptions(options);

        this.currFocus = {};
        this._contextSize = [undefined, undefined];

        this._eventInput = new EventHandler();
        this._eventOutput = new EventHandler();

        EventHandler.setInputHandler(this, this._eventInput);
        EventHandler.setOutputHandler(this, this._eventOutput);
    }

    FocusScrollLayout.DEFAULT_OPTIONS = {
        direction: Utility.Direction.Y,
        margin: 1000,
        edgeGrip: 0.2,
        springPeriod: 300,
        springDamp: 1
    };

    function _sizeForDir(size) {
        var dimension = this.options.direction;
        return size[dimension] === undefined ? null : size[dimension];
    }

    function _output(node, position, target, inverse) {
        var size = node.getSize();
        size = _sizeForDir.call(this, size);
        if (inverse) position -= size;

        var transform;
        if (this.options.direction === Utility.Direction.X)
            transform = Transform.translate(position, 0);
        else
            transform = Transform.translate(0, position);

        target.push({transform: transform, target: node.render()});
        return size;
    }

    FocusScrollLayout.prototype.getNormalizedPosition = function getNormalizedPosition(node, position, velocity, clipSize) {
        var normalized;
        if (window.$prenormalized && velocity !== 0)
            console.log('Normalize - Node: ' + node.getIndex() + ' Position: ' + position + ' Velocity: ' + velocity + ' Clip: ' + clipSize);

        var size = _sizeForDir.call(this, node.getSize());

        if (position < -size)
            normalized = node.getNext();
        else if (position > 0) {
            normalized = node.getPrevious();

            if (normalized) size = -_sizeForDir.call(this, normalized.getSize());
        }

        if (normalized) console.log('$NORMALIZED - Old: ' + node.getIndex() + ' New: ' + normalized.getIndex()
            + ' Position: ' + position + ' Velocity: ' + velocity + ' Clip: ' + clipSize);
        if (normalized) return {node: normalized, size: size};
    };

    FocusScrollLayout.prototype.setOptions = function setOptions(options) {
        this._optionsManager.setOptions(options);
    };

    FocusScrollLayout.prototype.renderLayout = function renderLayout(node, position, velocity, clipSize) {
        var result = [];
        if (window.$render)
            console.log('Render - Node: ' + node.getIndex() + ' Position: ' + position + ' Velocity: ' + velocity + ' Clip: ' + clipSize);

        // focus components
        var prevFocus = this.currFocus;
        this.currFocus = {};
        if (this._lastEdgeVisible)
            result = result;

        // used to determine edge state
        var firstEdgeVisible;
        var lastEdgeVisible;

        var offset = 0;
        clipSize = _sizeForDir.call(this, clipSize);
        var totalClip = clipSize + this.options.margin;
        var currNode = node;
        // always render atleast one node
        do {
            var elementOffset = _output.call(this, currNode, offset, result, false);
            if (offset + position < clipSize) {
                var visibleArea;

                // handle first / left side
                if (position + offset < 0)
                    visibleArea = -elementOffset - position;
                // handle right side
                else if (offset + elementOffset + position > clipSize)
                    visibleArea = clipSize - offset - position;
                else
                    visibleArea = elementOffset;

                offset += elementOffset;

                // whether or not the whole element is visible
                var isVisible = visibleArea === elementOffset ? 1 : 0;
                var visibleElement = currNode.get();
                var prevElement = prevFocus[visibleElement.id];
                if (!prevElement || prevElement.visibleArea !== visibleArea) {
                    if (visibleElement && visibleElement.focus instanceof Function)
                        visibleElement.focus(isVisible, visibleArea);

                    this.currFocus[visibleElement.id] = {
                        element: visibleElement,
                        isVisible: isVisible,
                        visibleArea: visibleArea
                    };
                }
                else
                    this.currFocus[visibleElement.id] = prevElement;

                prevFocus[visibleElement.id] = undefined;
            }
            else
                offset += elementOffset;

            currNode = currNode.getNext ? currNode.getNext() : null;
        }
        while (currNode && offset + position < totalClip);

        if (!currNode && offset + position <= clipSize) lastEdgeVisible = true;

        // backwards
        currNode = node && node.getPrevious ? node.getPrevious() : null;
        if (!currNode && position >= 0)
            firstEdgeVisible = true;

        var lastEdgePosition = clipSize - offset;

        offset = 0;
        while (currNode && -this.options.margin < offset + position) {
            offset -= _output.call(this, currNode, offset, result, true);
            currNode = currNode.getPrevious ? currNode.getPrevious() : null;
        }

        var edgeEvent = {
            layout: this,
            scale: this.options.edgeGrip,
            period: this.options.springPeriod,
            dampingRatio: this.options.springDamp
        };

        if (firstEdgeVisible || lastEdgeVisible) {
            var edgeStateChanged;
            if (lastEdgeVisible && this._edgeState !== ScrollEdgeStates.LAST) {
                this._edgeState = ScrollEdgeStates.LAST;
                edgeEvent.edge = this._edgeState;
                edgeEvent.anchor = [lastEdgePosition, 0, 0];
                edgeStateChanged = true;
            }
            // L2R
            if (firstEdgeVisible && this._edgeState !== ScrollEdgeStates.FIRST) {
                this._edgeState = ScrollEdgeStates.FIRST;
                edgeEvent.edge = this._edgeState;
                edgeEvent.anchor = [0, 0, 0];
                edgeStateChanged = true;
            }
            if (edgeStateChanged)
                this._eventOutput.emit('onEdge', edgeEvent);
        }
        else if (this._edgeState !== ScrollEdgeStates.NONE) {
            this._edgeState = ScrollEdgeStates.NONE;
            edgeEvent.edge = this._edgeState;
            this._eventOutput.emit('offEdge', edgeEvent);
        }

        if (prevFocus) {
            var outFocusKeys = Object.keys(prevFocus);
            for (var i = 0, l = outFocusKeys.length; i < l; i++) {
                var prevFocusId = outFocusKeys[i];
                var prevFocusItem = prevFocus[prevFocusId];
                if (prevFocusItem !== undefined) {
                    var prevFocusElement = prevFocusItem.element;
                    if (prevFocusElement && prevFocusElement.focus instanceof Function)
                        prevFocusElement.focus(-1, 0);
                }
            }
        }

        return result;
    };

    module.exports = FocusScrollLayout;
});
