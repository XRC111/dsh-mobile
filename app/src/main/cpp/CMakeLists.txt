cmake_minimum_required(VERSION 3.22.1)
project(dsh_node_runner CXX)

# libnode.so（nodejs-mobile 24.21.0-0，arm64-v8a）以导入库方式链接
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
    IMPORTED_LOCATION ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

add_library(node_runner SHARED node-runner.cpp)
target_include_directories(node_runner PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../jniInclude/node)
target_link_libraries(node_runner node log)
target_compile_options(node_runner PRIVATE -std=c++20 -fexceptions -frtti)
