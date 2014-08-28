
var stream = require('stream');
var util = require("util");
var events = require("events");
var HamlNode = require("./HamlNode");
var Q = require("kew");
var vm = require("vm");

// function Trees2proc(options) {
// }

function Trees2proc(options) {
  if (!options) { options = {}; }
  options.objectMode = true;
  stream.Transform.call(this, options);

  this.level = -1;
  // list of templates
  this.templates = [];
  this.templatesMatches = {};

  this.contextStack = [this.executeDefault];
  this.levelState = [];
  this.context = vm.createContext({});
  this.eventQueue = [];
}
util.inherits(Trees2proc, stream.Transform);

Trees2proc.prototype._transform = function (event, encoding, done) {
  // console.log("transform", event);
  this.eventQueue.push(event);
  while (this.eventQueue[0]) {
    this.process(this.eventQueue.shift());
  }
  done();
};

Trees2proc.prototype.process = function (event) {
  if (event.type == "start") {
    this.levelState.unshift({});
  } else if (event.type == "end") {
    var level = this.levelState.shift();
    // console.log("level", level);
    if (level && level.onEnd) {
      if (!level.onEnd.call(this, event)) {
        console.log("ignoring", event);
        return; // hook can return false to get the event ignored
      }
    }
  }
  var func = this.contextStack[this.contextStack.length - 1];
  func.call(this, event);
};

Trees2proc.prototype.captureFirstText = function () {
  var def = Q.defer();
  var text = "";

  this.contextStack.push(function(event) {
    switch (event.type) {
     case "text":
      text += event.text;
      return;
     case "start": // a child
     case "end": // with or without text
      this.contextStack.pop(); // means a return
      this.eventQueue.unshift(event);
      def.resolve(text);
      // this.process(event);
      break;
    default:
    }

  });

  return def.promise;
};

Trees2proc.prototype.captureEnd = function () {
  var def = Q.defer();
  var text = "";

  this.contextStack.push(function(event) {
    // console.log("event end", event);
    if (event.type == "end") {
      this.contextStack.pop(); // means a return
      def.resolve(event);
    }
  });

  return def.promise;
};

Trees2proc.prototype.evalExpression = function (expr) {
  // console.log("captureTextAndEval: got expr", expr);
    try {
      var value = vm.runInContext(expr, this.context);
      // console.log("captureTextAndEval: VALUE = ", value);
    }
    catch (e) {
      console.error(":eval expression failed: <<", expr, ">> error is:", e);
      value = e;
    }
    return value;
};

Trees2proc.prototype.captureTextAndEval = function () {
  return this.captureFirstText().then(this.evalExpression.bind(this));
};

////////////////////////////////////////////////////////////////////////////////

Trees2proc.prototype.executeDefault = function (event) {
  if (event.type == "start") {
    if (event.name[0] == ":") {
      var fname = "command_"+event.name.slice(1);
      if (this[fname]) {
        return this[fname].call(this, event);
      } else {
        console.error("command not found:", event.name);
      }
    } else if ( /=$/.test(event.name)) {
      return this.op_affect(event);
    }
  }
  this.push(event);
};

Trees2proc.prototype.op_affect = function (event) {
  event = { type: event.type, name: event.name.replace(/=$/, "") };
  this.push(event);
  this.captureTextAndEval().then(function(value) {
    if (value instanceof Error) {
      value = "[JS expression error: "+value+"]";
    }
    this.push({ type: "text", text: ""+value });
  }.bind(this)).done();
};

Trees2proc.prototype.command_eval = function (event) {
  return this.captureFirstText().then(function(text) {
    try {
      vm.runInContext(text, this.context);
    }
    catch (e) {
      console.error(":eval expression failed: ", e);
    }
  }.bind(this))
    .then(this.captureEnd.bind(this)).done();
};

Trees2proc.prototype.command_if = function (event) {
  // this.levelState
  this.captureTextAndEval().then(function(value) {
    // console.log("if:value:", value, !!value);
    if (value instanceof Error) {
      this.push(event);
      this.push({ type: "text", text: "[JS expression error: "+value+"]" });
      return;
    }
    if (!!value) {
      // console.error("if IN", this.levelState, this);
      this.levelState[0].onEnd = function(event) { return false; };
    } else {
      // console.log("if OUT");
      this.contextStack.push( // do nothing
        function(event) { console.log("do nothing", event);});
      this.levelState[0].onEnd = // except when level gets shifted, we "return" (pop)
      function(event) { console.log("gni"); this.contextStack.pop(); return false; };
    }
  }.bind(this)).done();
};

Trees2proc.prototype.command_each = function (event) {

  this.captureFirstText().then(function(text) {

    var parts = text.split(" in ");
    console.log("foreach:", parts);
    if (parts.length < 2) {
      console.log(":each bad syntax argument:", text);
      this.push(event);
      this.push({ type: "text", text: text });
      return;
    }

    var name = parts[0].trim();
    var array = this.evalExpression(parts[1].trim());
    console.log("each array", name, array);


    this.captureAllLevelEvents().then(function(buffer) {

      console.log("BUFFER", buffer);
      for (var i = 0; i < array.length; i++) {
        // var value = array[i]
        var expr = name + " = " + parts[1].trim() + "["+i+"]";
        console.log("expr:", expr);
        var _ = this.evalExpression(expr);
        this.playBuffer(buffer);
        }
      _ = this.evalExpression("delete item;");
    }.bind(this)).done();


    function playIdx() {
    }


  }.bind(this)).done();
};

Trees2proc.prototype.playBuffer = function (buffer) {
  buffer.forEach(function(event) {
    console.log("BUFFER EVENT", this.levelState.length, event, this.levelState);
    this.process(event);
  }, this);
  // buffer.forEach(this.process, this);
};

Trees2proc.prototype.captureAllLevelEvents = function () {
  var buffer = [];
  var def = Q.defer();
  this.levelState[0].onEnd = function(event) {
    // console.log("EAHC END", this.levelState.length);
    this.contextStack.pop();
    // console.log("AFTER END", this.levelState.length);
    buffer.push(event);
    def.resolve(buffer);
    return false;
  };
  this.contextStack.push(function(event) {
    buffer.push(event);
  });

  return def.promise;
};

Trees2proc.prototype.command_template = function (event) {
};

////////////////////////////////////////////////////////////////////////////////

Trees2proc.prototype.___transform = function (event, encoding, done) {

  var name;

  if (event.type == "start") {
    this.level++;
  }
  var forward = true;

  // console.log("tr", this.level, event, "defining", this.defining && this.defining.level);
  if (this.defining) {
    // in template
    if (this.level == this.defining.level) {
      if (event.type == "end") {
        // this.defining.content.push(event);
        this.templates.push(this.defining);
        this.templatesMatches[this.defining.selector] = this.defining;
        // console.log("** pushed template", this.defining);
        this.defining = null;
        forward = false;

      } else if (event.type == "text") {
        this.defining.selector = event.text;
        forward = false;
      }
    } else if (this.level > this.defining.level) {
      this.defining.content.push(event);
      forward = false;
    }
  } else {

    if (event.type == "start") {
      if (event.name == ":apply") {
        this.defining = {type:"template",level:this.level,content:[]};
        forward = false;
      } else {
        var _t = this.templatesMatches[event.name];
        if (_t) {
          _t.content.forEach(function(tEevent) {
            this.push(tEevent);
          }, this);
        }
      }
    }
  }

  if (forward) {
    this.push(event);
  }

  if (event.type == "end") {
    this.level--;
  }

  done();
};
Trees2proc.prototype._flush = function (done) {
  // console.log("flush");
  if (done) {
    done();
  }
};


module.exports = Trees2proc;
