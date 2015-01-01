/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * @license MPL 2.0
 * @copyright Joseph Carroll <jdsalingerjr@gmail.com>
 */
define(function(require, exports, module) {
    var OptionsManager = require('famous/core/OptionsManager');
    var Transform = require('famous/core/Transform');
    var Utility = require('famous/utilities/Utility');
    var ViewSequence = require('famous/core/ViewSequence');
    var EventHandler = require('famous/core/EventHandler');

    function FocusScrollLayout(options) {
        this.options = Object.create(this.constructor.DEFAULT_OPTIONS);
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
        springDamp: 1,
    };

    function _sizeForDir(size) {
        var dimension = this.options.direction;
        return (size[dimension] === undefined) ? null : size[dimension];
    }

    function _output(node, position, target) {
        var size;
        if (!node.getSize)
            size = 0;
        else
            size = node.getSize();
        var transform;
        if (this.options.direction === Utility.Direction.X) {
            transform = Transform.translate(position, 0);
        }
        else {
            transform = Transform.translate(0, position);
        }
        target.push({transform: transform, target: node.render()});
        return _sizeForDir.call(this, size);
    }

    FocusScrollLayout.prototype.getNodeSize = function getNodeSize(node, index) {
        var direction = this.options.direction;
        var nodeSize = node.getSize();
        return _sizeForDir.call(this, nodeSize);
    }

    FocusScrollLayout.prototype.setOptions = function setOptions(options) {
        this._optionsManager.setOptions(options);
    };

    FocusScrollLayout.prototype.renderLayout = function renderLayout(node, offset, clipSize) {
        var result = [];

        // focus components
        var prevFocus = this.currFocus;
        this.currFocus = {};
        if (this._lastEdgeVisible)
            result = result;

        // used to determine edge state
        var firstEdgeVisible;
        var lastEdgeVisible;

        var position = 0;
        clipSize = _sizeForDir.call(this, clipSize);
        var totalClip = clipSize +  this.options.margin;
        var currNode = node;
        // always render atleast one node
        do {
            var elementOffset = _output.call(this, currNode, position, result);
            if (position + offset < clipSize) {
                var visibleArea;
                // handle first / left side
                if (offset + position < 0) {
                    visibleArea = -elementOffset - offset;
                }
                // handle right side
                else if (position + elementOffset + offset > clipSize) {
                    visibleArea = clipSize - position - offset;
                }
                else {
                    visibleArea = elementOffset;
                }
                position += elementOffset;

                // whether or not the whole element is visible
                var isVisible = visibleArea === elementOffset ? 1 : 0;
                var visibleElement = currNode.get();
                var prevElement = prevFocus[visibleElement.id];
                if (!prevElement || prevElement.visibleArea !== visibleArea) {
                    if (visibleElement && visibleElement.focus instanceof Function) {
                        visibleElement.focus(isVisible, visibleArea);
                    }
                    this.currFocus[visibleElement.id] = {
                        element: visibleElement,
                        isVisible: isVisible,
                        visibleArea: visibleArea
                    }
                }
                else {
                    this.currFocus[visibleElement.id] = prevElement;
                }
                prevFocus[visibleElement.id] = undefined;
            }
            else {
                position += elementOffset;
            }
            currNode = currNode.getNext ? currNode.getNext() : null;
        }
        while (currNode && position + offset < totalClip);

        if (!currNode && position + offset <= clipSize) {
            lastEdgeVisible = true;
        }

        // backwards
        currNode = (node && node.getPrevious) ? node.getPrevious() : null;
        if (!currNode && offset >= 0) {
            firstEdgeVisible = true;
        }

        var lastEdgePosition = clipSize - position;

        position = 0;
        while (currNode && -this.options.margin < position + offset) {
            position -= _output.call(this, currNode, position, result);
            currNode = currNode.getPrevious ? currNode.getPrevious() : null;
        }

        var edgeEvent = {
            layout: this,
            edgeGrip: this.options.edgeGrip,
            springPeriod: this.options.springPeriod,
            springDamp: this.options.springDamp,
            firstEdgeVisible: false,
            lastEdgeVisible: false
        };

        if (firstEdgeVisible || lastEdgeVisible) {
            var edgeStateChanged;
            if (lastEdgeVisible && !this._lastEdgeVisible) {
                this._lastEdgeVisible = lastEdgeVisible;
                edgeEvent.lastEdgeVisible = lastEdgeVisible;
                edgeEvent.position = lastEdgePosition;
                edgeStateChanged = true;
            }
            // L2R
            if (firstEdgeVisible && !this._firstEdgeVisible) {
                this._firstEdgeVisible = firstEdgeVisible;
                edgeEvent.firstEdgeVisible = firstEdgeVisible;
                edgeEvent.position = 0;
                edgeStateChanged = true;
            }
            if (edgeStateChanged) {
                this._eventOutput.emit('onEdge', edgeEvent);
            }
        }
        else if (this._firstEdgeVisible || this._lastEdgeVisible) {
            this._firstEdgeVisible = false;
            this._lastEdgeVisible = false;
            edgeEvent.edgeGrip = 0;
            this._eventOutput.emit('offEdge', edgeEvent);
        }

        if (prevFocus) {
            var outFocusKeys = Object.keys(prevFocus);
            for (var i = 0, l = outFocusKeys.length; i < l; i++) {
                var prevFocusId = outFocusKeys[i];
                var prevFocusItem = prevFocus[prevFocusId];
                if (prevFocusItem !== undefined) {
                    var prevFocusElement = prevFocusItem.element;
                    if (prevFocusElement && prevFocusElement.focus instanceof Function) {
                        prevFocusElement.focus(-1, 0);
                    }
                }
            }
        }

        return result;
    };

    module.exports = FocusScrollLayout;
});