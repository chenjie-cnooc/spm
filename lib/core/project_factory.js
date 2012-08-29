// 项目分析模块

var path = require('path');
var fs = require('fs');

var fsExt = require('../utils/fs_ext.js');
var env = require('../utils/env.js');
var StringUtil = require('../utils/string.js');
var Opts = require('../utils/opts.js');

var help = require('../utils/moduleHelp');
var Sources = require('./sources.js');
var ConfigParse = require('./config_parse.js');
var isRelative = help.isRelative;

var SPM_CONFIG = 'config.json';
var CONFIG = 'package.json';
var home = env.home;
var argv;

/**
 * 产生整体项目模型对象，包括项目基本信息，build(plugin)信息。
 * @param {String} action 当前action.
 * @param {Object} modDir 项目目录.
 * @return {Object} 项目对象.
 */
exports.getProjectModel = function(action, modDir, callback) {
  // 给项目模型提供指定action 参数信息.
  argv = Opts.get(action).argv;
  return new Module(modDir, callback);
};

//项目基类，里面将封转一些常用的方法.
function Module(modDir, callback) {
  var that = this;
  this.baseDirectory = modDir;
  this.globalHome = path.join(home, '.spm');
  var modConfig = this.modConfig = new ConfigParse(); 
  modConfig.addParseRule('parent', function(value, filepath) {
    var parentPath = path.join(path.dirname(filepath), value);
    this.addFile(parentPath, null, true);
  });

  var baseConfig = path.join(this.baseDirectory, CONFIG);
  if (fsExt.existsSync(baseConfig)) {
    modConfig.addFile(baseConfig);
  }

  var gc = argv['global-config'];
  if (gc) {
    gc = perfectLocalPath(gc);
    modConfig.addFile(gc);
  }

  var globalConfig = path.join(this.globalHome, SPM_CONFIG); 
  if (fsExt.existsSync(globalConfig)) {
    modConfig.addFile(globalConfig);
  }
  
  var create = function(obj) {
    this._initGlobalInfo(obj);

    // 查找那些是保留依赖.
    this._initResolvedDeps();
  
    this.moduleDepMapping = {};
    this.moduleSources = new Sources(this);
    callback(this);
  };

  if (modConfig.isEnd()) {
    create.call(this, modConfig._obj);
  } else {
    modConfig.once('end', function(config) {
      create.call(that, config._obj);
    });
  }
}

Module.prototype = {

  _perfectSources: function(sources) {
    sources = sources || [];
    return sources.map(function(source) {
      if (isLocalPath(source)) {
        source = perfectLocalPath(source);
      } else {
        if (source.indexOf('http') !== 0) {
          source = 'http://' + source;
        }
      }
      return source;
    });
  },

  // 初始化项目的一些全局信息.
  _initGlobalInfo: function(modConfig) {
    Module.prototype.__proto__ = modConfig;

    // 目前模块名称是通过配置获取.
    this.version = argv.version || this.version;

    this.dependencies = this.dependencies || {};
    this.plugins = this.plugins || {};
    this.sources = this._perfectSources(this.sources);
    var source = this.getSource();

    var root = this.root;
    if (root === '#') {
      root = '';
    }

    // 如果是本地源.
    if (help.isLocalPath(source)) {
      this.baseSourcePath = source;
    } else {
      this.baseSourcePath = path.join(this.globalHome, 'sources',
        help.getHost(source));
    }

    // 模块基本路径 root/name/version
    this.baseModuleDir = path.join(root, this.name, this.version);

    // TODO 后续支持src, dist配置.
    var baseDir = this.baseDirectory;
    if (argv.dist) {
      this.distDirectory = perfectLocalPath(argv.dist);
    } else {
      this.distDirectory = path.join(baseDir, 'dist');
    }

    if (argv.src) {
      this.srcDirectory = perfectLocalPath(argv.src);
    } else {
      this.srcDirectory = path.join(baseDir, 'src');
    }

    this.buildDirectory = path.join(baseDir, 'build');

    // 创建相关目录。
    fsExt.mkdirS(this.buildDirectory);
    fsExt.mkdirS(this.distDirectory);

    this.type = this._getProjectType();
  },

  _initResolvedDeps: function() {
    var deps = this.dependencies;
    var resolvedDeps = this.resolvedDeps = [];
    for (var dep in deps) {
      if (deps[dep] === dep) {
        resolvedDeps.push(dep);
      }
    }
  },

  // 获取项目source.由于可能有多个数据源, 默认用户配置的第一个source为项目source.
  getSource: function() {
    var sources = this.sources;
    if (!sources || sources.length === 0) {
      console.warn(this.name + ' not found available source!');
      return '';
    }
    return sources[0];
  },

  _getProjectType: function() {
    var srcDirectory = this.srcDirectory;
    var files = fs.readdirSync(srcDirectory);
    var isJs = files.some(function(filename) {
      return path.extname(filename) === '.js';
    });
    return isJs ? 'js' : 'css';
  },

  // 如果用户没有配置~/.spm/config.json,自动替用户创建.
  _createGlobalConfig: function() {
    var tplConfigDir = path.join(path.dirname(module.filename), '../help/');
    fsExt.mkdirS(this.globalHome);
    fsExt.copyFileSync(tplConfigDir, this.globalHome, SPM_CONFIG);
  },

  // 获取指定模块的依赖关系.
  getDepMapping: function(moduleName) {
    return this.moduleDepMapping[this.getModuleId(moduleName)];
  },

  // 根据模块名，获取模块id.
  getModuleId: function(moduleName) {
    var version = this.version;
    var root = this.root || (this.root = '');
    var modId = '';
    var ext = path.extname(moduleName);
    var extReg = new RegExp('\\' + ext + '$');
    modId = path.join(modId + this.name, version, moduleName.replace(extReg, ''));
    modId = env.normalizePath(modId);

    if (root === '#' || root === '') {
      modId = root + modId;
    } else {
      if (root.lastIndexOf('/') === root.length -1) {
        root = root.slice(0, root.length - 1);
      }
      modId = root + '/' + modId;
    }

    return modId;
  },

  // 获取global module id.
  // support class: 0.9.0
  // 如果设置slient不提示警告.
  // 根据 **throwErrorOnDepNotFound** 确定如果没有发现依赖的模块则提示错误.
  getGlobalModuleId: function(moduleName, slient) {
    var moduleId = this.dependencies[moduleName];
    if (isVersion(moduleId)) {
      moduleId = env.normalizePath(path.join(moduleName, moduleId, moduleName));
    }

    if (!moduleId && !slient) { 

      // fix https://github.com/seajs/spm/issues/192
      var errMsg = 'Not Found ' + moduleName + ' dependencies config!';
      if (argv.throwErrorOnDepNotFound) {
        throw errMsg;
      } else {
        console.warn(errMsg);
        moduleId = moduleName;
      }
    }
    return moduleId;
  },

  // 重置模块id.
  resetGlobalModuleId: function(moduleName, moduleId) {
    this.dependencies[moduleName] = moduleId;
  },

  // 根据模块name，生成模块路径。
  getModulePath: function(moduleName) {
    return path.join(this.srcDirectory, moduleName);
  },

  // 根据模块的文件路径，和模块的相对依赖，获取依赖模块的路径
  getDepModulePath: function(modulePath, depModule) {
      return path.join(path.dirname(modulePath), depModule);
  },

  // 从build目录获取模块代码，因为我们后续操作的代码都应该是build目录中的.
  getModuleCode: function(moduleName) {
    return fsExt.readFileSync(this.buildDirectory, normalize(moduleName));
  },

  // 获取全局模块代码.
  getGlobalModuleCode: function(moduleId, callback) {
    return this.moduleSources.getModule(moduleId, function(err, moduleCode) {
      callback(moduleCode);
    });
  },

  // 获取模块的依赖关系
  getModuleDepMapping: function(moduleId) {
    return this.moduleDepMapping[moduleId];
  },

  // parse package.json
  getProjectInfo: function() {
    return getProjectInfo(this.projectDir);
  },

  /**
   * 获取指定类型的正则.
   * @param {String} moduleType 具体模块类型正则.
   * @return {RegExp} 返回对应类型正则.
   */
  getReqModRegByType: function(moduleType) {
    return new RegExp('(^|[^.])\\brequire\\s*\\(\\s*(["\'])(' +
      moduleType + ')\\2\\s*\\)', 'g');
  }
};

function isLocalPath(requestUrl) {
  if (requestUrl.indexOf('~') === 0) return true;
  if (requestUrl.indexOf('http') > -1) return false;
  if (fsExt.existsSync(requestUrl)) {
    return true;
  }
  return false;
}

function perfectLocalPath(localPath) {
  if (localPath.indexOf('~') === 0) {
    return localPath.replace(/~/, home);
  }

  if (env.isAbsolute(localPath)) {
    return localPath;
  }

  return path.join(process.cwd(), localPath);
}

var versionReg = /^(?:\d+\.){2}\d+(?:-dev)?$/;
function isVersion(id) {
  return versionReg.test(id);
}

function normalize(module) {
  module = path.normalize(module);
  if (!path.extname(module)) {
    module += '.js';
  }
  return module;
}